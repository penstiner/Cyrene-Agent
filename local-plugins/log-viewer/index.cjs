"use strict";

// 日志查看器插件 —— 实时预览 userData/logs/ 下的运行日志。
//
// 纯文件系统访问：日志目录 = app.getPath("userData")/logs（Electron 公开 API），
// 不触碰任何应用内部模块。支持：
// - open() 打开查看器窗口：级别过滤 / 关键词搜索 / 文件切换 / 实时跟随（fs.watch 增量读取）
// - log-viewer_recent 工具：LLM 查询最近日志（「最近有什么报错」）
//
// 日志格式（src/main/log-sink-file.ts）：`YYYY-MM-DD HH:MM:SS.mmm LEVEL Tag      message`，
// 无时间戳前缀的行是上一条目的续行（堆栈等）；滚动文件为 cyrene.log / .1 / .2。

const path = require("node:path");
const fs = require("node:fs");

const TAIL_DEFAULT_BYTES = 256 * 1024;
const TOOL_TAIL_BYTES = 64 * 1024;
const WATCH_DEBOUNCE_MS = 300;
const ENTRY_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(DEBUG|INFO|WARN|ERROR)\b\s*(.*)$/;
const KNOWN_LEVELS = ["ERROR", "WARN", "INFO", "DEBUG"];

let viewerWindow = null;
let dirWatcher = null;
let fileSizes = new Map();
let debounceTimer = null;
let activeLogFile = "cyrene.log";

module.exports = {
  async register(ctx) {
    ctx.registerTool({
      id: "log-viewer_recent",
      name: "查询运行日志",
      description:
        "查询 Cyrene 最近的运行日志（主日志 cyrene.log）。排查问题、用户问「最近有没有报错」「日志里怎么了」时使用。" +
        "level='error' 只看错误，'warn' 错误+警告，'all' 全部；lines 控制返回条数（默认 30，最大 200）。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: {
        type: "object",
        properties: {
          level: {
            type: "string",
            enum: ["all", "warn", "error"],
            description: "日志级别过滤：'all'=全部，'warn'=警告及以上，'error'=仅错误。默认 all。",
          },
          lines: { type: "number", description: "返回条数，默认 30，最大 200" },
        },
        required: [],
      },
      execute: (args) => runRecentQuery(ctx, args),
    });

    ctx.registerIpc("get-files", async () => {
      return { files: listLogFiles(), activeFile: activeLogFile };
    });
    ctx.registerIpc("read-tail", async (file, maxBytes) => {
      const name = sanitizeFileName(file) ?? activeLogFile;
      return {
        file: name,
        entries: readTailEntries(name, Number(maxBytes) > 0 ? Number(maxBytes) : TAIL_DEFAULT_BYTES),
        size: fileSizeOf(name),
      };
    });

    ctx.onDispose(() => stopWatching());
    ctx.log("日志查看器插件已注册");
  },

  async open() {
    if (viewerWindow && !viewerWindow.isDestroyed()) {
      viewerWindow.focus();
      return;
    }
    const { BrowserWindow } = require("electron");
    viewerWindow = new BrowserWindow({
      width: 980,
      height: 660,
      autoHideMenuBar: true,
      title: "Cyrene 日志查看器",
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    viewerWindow.on("closed", () => {
      viewerWindow = null;
      stopWatching();
    });
    await viewerWindow.loadFile(path.join(__dirname, "ui.html"));
    startWatching();
  },

  async unregister() {
    stopWatching();
    if (viewerWindow && !viewerWindow.isDestroyed()) viewerWindow.close();
    viewerWindow = null;
  },
};

// ── 目录与文件 ──

function logsDir() {
  const override = String(process.env.CYRENE_LOG_VIEWER_DIR ?? "").trim();
  if (override) return override;
  const { app } = require("electron");
  return path.join(app.getPath("userData"), "logs");
}

function listLogFiles() {
  const dir = logsDir();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.log(\.\d+)?$/.test(n));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      let size = 0;
      let mtimeMs = 0;
      try {
        const st = fs.statSync(path.join(dir, name));
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch { /* 文件刚被滚动删除 */ }
      return { name, size, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function fileSizeOf(name) {
  try {
    return fs.statSync(path.join(logsDir(), name)).size;
  } catch {
    return 0;
  }
}

function sanitizeFileName(file) {
  const name = String(file ?? "").trim();
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) return null;
  if (!/\.log(\.\d+)?$/.test(name)) return null;
  return name;
}

// ── 读取与解析 ──

/** 从文件尾部读取 maxBytes，解析为条目数组（续行并入上一条）。 */
function readTailEntries(name, maxBytes) {
  const filePath = path.join(logsDir(), name);
  let buf;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const length = size - start;
      buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const text = buf.toString("utf8");
  // 首行可能是被截断的半条：丢弃到第一个完整条目开头
  const firstEntry = text.search(ENTRY_RE);
  const body = firstEntry > 0 ? text.slice(firstEntry) : text;
  return parseEntries(body.split(/\r?\n/));
}

function parseEntries(lines) {
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = ENTRY_RE.exec(line);
    if (m) {
      entries.push({
        ts: m[1],
        level: m[2],
        tag: extractTag(m[3]),
        message: m[3],
        raw: line,
        cont: [],
      });
    } else if (entries.length > 0) {
      entries[entries.length - 1].cont.push(line);
    }
  }
  return entries;
}

function extractTag(rest) {
  const m = /^([A-Za-z0-9_]+)\s+/.exec(rest);
  return m ? m[1] : "";
}

/** 读取尾部并在主进程侧过滤（供 LLM 工具用）：返回最近 N 条文本。 */
function recentText(name, levelFilter, maxLines) {
  const entries = readTailEntries(name, TOOL_TAIL_BYTES);
  const filtered = entries.filter((e) => {
    if (levelFilter === "error") return e.level === "ERROR";
    if (levelFilter === "warn") return e.level === "ERROR" || e.level === "WARN";
    return true;
  });
  const picked = filtered.slice(-maxLines);
  if (picked.length === 0) {
    return `最近 ${TOOL_TAIL_BYTES / 1024}KB 日志中没有${levelFilter === "all" ? "" : levelFilter === "error" ? "错误" : "警告或错误"}记录。`;
  }
  const lines = [`最近 ${picked.length} 条日志（${name}）：`];
  for (const e of picked) {
    lines.push(e.raw);
    for (const c of e.cont) lines.push("    " + c);
  }
  return lines.join("\n");
}

// ── LLM 工具主流程 ──

async function runRecentQuery(ctx, args) {
  const levelFilter = ["warn", "error"].includes(args?.level) ? args.level : "all";
  const rawLines = Number(args?.lines ?? 30);
  const maxLines = Math.min(Math.max(Number.isFinite(rawLines) ? Math.trunc(rawLines) : 30, 1), 200);
  try {
    const files = listLogFiles();
    const name = files.some((f) => f.name === activeLogFile) ? activeLogFile : (files[0]?.name ?? "cyrene.log");
    return recentText(name, levelFilter, maxLines);
  } catch (err) {
    return `[工具执行失败] 读取日志失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── 实时跟随（fs.watch 增量推送）──

function startWatching() {
  if (dirWatcher) return;
  const dir = logsDir();
  fileSizes = new Map(listLogFiles().map((f) => [f.name, f.size]));
  try {
    dirWatcher = fs.watch(dir, { persistent: false }, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(pollChanges, WATCH_DEBOUNCE_MS);
    });
  } catch (err) {
    // 目录不存在等情况：查看器仍有手动刷新可用
    console.warn("[LogViewer] fs.watch 失败：", err instanceof Error ? err.message : String(err));
  }
}

function stopWatching() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (dirWatcher) {
    dirWatcher.close();
    dirWatcher = null;
  }
}

function pollChanges() {
  if (!viewerWindow || viewerWindow.isDestroyed()) return;
  const files = listLogFiles();
  for (const f of files) {
    const prev = fileSizes.get(f.name);
    const size = f.size;
    if (prev === undefined || size === prev) continue;
    const filePath = path.join(logsDir(), f.name);
    try {
      const fd = fs.openSync(filePath, "r");
      try {
        // 变小 = 滚动/清空：整段重读；变大：只读增量
        const rotated = size < prev;
        const start = rotated ? Math.max(0, size - TAIL_DEFAULT_BYTES) : prev;
        const length = size - start;
        if (length <= 0) continue;
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, start);
        const entries = parseEntries(buf.toString("utf8").split(/\r?\n/));
        if (entries.length > 0 && f.name === activeLogFile) {
          viewerWindow.webContents.send("plugin:log-viewer:append", { file: f.name, rotated, entries });
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch { /* 文件恰好被滚动替换，下轮轮询自愈 */ }
    fileSizes.set(f.name, size);
  }
}

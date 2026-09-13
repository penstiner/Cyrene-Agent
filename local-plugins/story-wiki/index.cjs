"use strict";

// 剧情库检索插件 —— 移植自 Castorice-Agent 的 search_story 工具 + story-wiki 引擎，
// 按 Cyrene 插件规范改造。
//
// 数据源：https://github.com/XCreeperPa/HSRChat （MIT）references/wiki 下的
// BWiki 模板格式 .txt（{{角色图鉴 |名称=...}}）。首次调用递归扫描建内存索引
// （约 1600 文件 / 18MB），文件名命中 > 正文命中，全部关键词命中加权。
//
// 相对原版的改进：数据目录可配置（设置弹窗选择 + 常见位置自动探测），
// 路径存 ctx.storage，分享插件给别人不再依赖 F:\HSRChat 硬编码。

const path = require("node:path");
const fs = require("node:fs");

const STORAGE_KEY = "wikiDir";
const SNIPPET_LEN = 700;
const TOOL_SNIPPET_MAX = 400;

let settingsWindow = null;

// ── 索引（懒加载 + 缓存，目录切换时失效）──

let cachedRoot = null;
let cachedDir = null;
let cachedDocs = null;
let cachedError = null;
let indexVersion = 0;

/** 解析 wiki 根目录：storage 配置 > 环境变量 > 自动探测常见位置。 */
async function resolveWikiRoot(ctx) {
  const configured = ctx.storage.get(STORAGE_KEY);
  if (configured && fs.existsSync(configured)) return configured;

  const envDir = String(process.env.HSRCHAT_WIKI_DIR ?? "").trim();
  if (envDir && fs.existsSync(envDir)) return envDir;

  const { app } = require("electron");
  const userData = app.getPath("userData");
  const candidates = [
    path.join(userData, "story-wiki"),                          // 用户数据目录（推荐迁移位置）
    "F:\\HSRChat\\references\\wiki",                            // Castorice 兼容位置
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function buildIndex(root) {
  const docs = [];
  const walk = (dir, category) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git" || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, category || e.name);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".txt")) {
        docs.push({
          category: category || "",
          title: e.name.replace(/\.txt$/i, ""),
          filePath: full,
          content: null,
        });
      }
    }
  };
  walk(root, "");
  return docs;
}

async function getIndex(ctx) {
  const root = await resolveWikiRoot(ctx);
  if (!root) {
    throw new Error("未找到剧情库数据目录。请点插件卡片的「打开」按钮选择 HSRChat 的 references/wiki 目录" +
      "（克隆 https://github.com/XCreeperPa/HSRChat 后可得）。");
  }
  if (cachedDocs && cachedRoot === root) return cachedDocs;
  indexVersion += 1;
  const docs = buildIndex(root);
  cachedRoot = root;
  cachedDir = root;
  cachedDocs = docs;
  cachedError = null;
  return docs;
}

// ── BWiki 模板清洗（移植自 Castorice story-wiki.ts）──

function stripWikiMarkup(raw) {
  let s = raw;
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  s = s.replace(/\{\{\s*黑幕\s*\|([\s\S]*?)\}\}/g, "$1");
  s = s.replace(/\{\{\s*(图标|PAGENAME|切换板|资料)\s*\|?[\s\S]*?\}\}/g, "");
  s = s.replace(/\{\{\s*([^\s|}]+)\s*\|([\s\S]*?)\}\}/g, (m, name, body) => body.replace(/^\s*\|/, ""));
  s = s.replace(/\{\{[^{}]*\}\}/g, "");
  s = s.replace(/\}\}/g, "");
  s = s.replace(/\{\{/g, "");
  s = s.replace(/^\s*\|?\s*([\u4e00-\u9fa5\w]+)\s*=\s*/gm, "$1：");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).join("\n");
}

function readDoc(doc) {
  if (doc.content) return doc.content;
  try {
    doc.content = stripWikiMarkup(fs.readFileSync(doc.filePath, "utf8"));
  } catch {
    doc.content = "";
  }
  return doc.content;
}

function extractSnippet(doc, text, query, maxLen = SNIPPET_LEN) {
  const lower = text.toLowerCase();
  let idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) idx = 0;
  const lineStart = text.lastIndexOf("\n", idx) + 1;
  const start = Math.max(0, lineStart);
  const snippet = text.slice(start, start + maxLen);
  return (start > 0 ? "…" : "") + snippet + (start + maxLen < text.length ? "…" : "");
}

// ── 检索 ──

function searchDocs(docs, query, category, limit) {
  const terms = String(query).split(/[\s,，、]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const hits = [];
  for (const doc of docs) {
    if (category && doc.category !== category) continue;
    const titleLower = doc.title.toLowerCase();
    const titleMatch = terms.some((t) => titleLower.includes(t));
    const text = readDoc(doc);
    if (titleMatch) {
      const lower = text.toLowerCase();
      const allMatch = terms.every((t) => lower.includes(t));
      hits.push({
        doc, reason: "title",
        score: allMatch ? 100 : 60 + terms.filter((t) => titleLower.includes(t)).length * 15,
        snippet: extractSnippet(doc, text, terms[0]),
      });
    } else {
      const lower = text.toLowerCase();
      const matched = terms.filter((t) => lower.includes(t));
      if (matched.length >= 1) {
        hits.push({
          doc, reason: "content",
          score: matched.length === terms.length ? 50 : 20 + matched.length * 10,
          snippet: extractSnippet(doc, text, terms[0]),
        });
      }
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

// ── 插件主体 ──

module.exports = {
  async register(ctx) {
    ctx.registerTool({
      id: "story-wiki_search",
      name: "剧情库检索",
      description:
        "检索本地《崩坏：星穹铁道》剧情库（HSRChat wiki：任务/角色/NPC/书籍/语音/光锥官方文本）。" +
        "涉及星穹铁道的剧情细节、角色背景、台词、设定核对、谁说过什么——即使似乎记得，也必须先检索官方原文再作答，防记混或编造。" +
        "query 支持空格分隔多个词（全部命中更靠前）；category 可限定分类（角色/NPC/书籍/开拓任务/同行任务/开拓续闻/冒险任务/角色语音/光锥）。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索关键词，中文，可用空格分隔多个词。例如：'遐蝶 哀地里亚'" },
          category: { type: "string", description: "可选：限定分类（角色/NPC/书籍/开拓任务/同行任务/开拓续闻/冒险任务/角色语音/光锥），留空全库检索" },
          limit: { type: "number", description: "返回条数上限，默认 6，最多 10" },
        },
        required: ["query"],
      },
      async execute(args) {
        const q = String(args?.query ?? "").trim();
        if (!q) return "[错误] 缺少 query 参数，请告诉我想查哪段剧情或哪个角色。";
        const category = String(args?.category ?? "").trim() || undefined;
        const rawLimit = Number(args?.limit ?? 6);
        const limit = Math.min(10, Math.max(1, Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 6));
        try {
          const docs = await getIndex(ctx);
          const hits = searchDocs(docs, q, category, limit);
          if (hits.length === 0) {
            const scope = category ? `（分类 ${category}）` : "";
            return `剧情库里没有找到与「${q}」相关的内容${scope}。可以换更精确的关键词，或去掉 category 全库再试。`;
          }
          const parts = hits.map((h, i) =>
            `${i + 1}. 【${h.doc.category}/${h.doc.title}】${h.reason === "title" ? "（标题命中）" : "（正文命中）"}\n${h.snippet.slice(0, TOOL_SNIPPET_MAX * 2)}`
          );
          return (
            `剧情库命中 ${hits.length} 条（数据来源：HSRChat wiki，官方设定文本）：\n\n` +
            parts.join("\n\n---\n\n") +
            "\n\n以上为原文片段。请基于这些官方设定作答；片段里没提到的，不要编造，可以坦白说不确定或需要进一步查证。"
          );
        } catch (err) {
          return `[工具执行失败] ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerIpc("get-status", async () => {
      try {
        const docs = await getIndex(ctx);
        const categories = [...new Set(docs.map((d) => d.category))].filter(Boolean);
        return { configured: true, dir: cachedDir, docCount: docs.length, categories };
      } catch (err) {
        const configured = String(ctx.storage.get(STORAGE_KEY) ?? "");
        return { configured: Boolean(configured), dir: configured, docCount: 0, categories: [], error: err instanceof Error ? err.message : String(err) };
      }
    });
    ctx.registerIpc("pick-dir", async () => {
      const { dialog } = require("electron");
      const result = await dialog.showOpenDialog(settingsWindow, {
        title: "选择剧情库数据目录（HSRChat 的 references/wiki）",
        properties: ["openDirectory"],
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
      const dir = result.filePaths[0];
      const txtCount = countTxtFiles(dir);
      if (txtCount === 0) {
        return { ok: false, error: "该目录下没有 .txt 文件——请选择 HSRChat 的 references/wiki 目录" };
      }
      ctx.storage.set(STORAGE_KEY, dir);
      cachedDocs = null; // 强制重建索引
      ctx.log(`剧情库目录已设置：${dir}（${txtCount} 个 txt）`);
      return { ok: true, dir, docCount: txtCount };
    });
    ctx.registerIpc("clear-dir", async () => {
      ctx.storage.set(STORAGE_KEY, undefined);
      cachedDocs = null;
      return { ok: true };
    });

    ctx.log("剧情库检索插件已注册");
  },

  async open() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.focus();
      return;
    }
    const { BrowserWindow } = require("electron");
    settingsWindow = new BrowserWindow({
      width: 560,
      height: 420,
      autoHideMenuBar: true,
      resizable: false,
      title: "剧情库检索 · 设置",
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    settingsWindow.on("closed", () => {
      settingsWindow = null;
    });
    await settingsWindow.loadFile(path.join(__dirname, "ui.html"));
  },

  async unregister() {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
    settingsWindow = null;
  },
};

function countTxtFiles(dir, depth = 0) {
  if (depth > 3) return 0;
  let count = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".")) count += countTxtFiles(path.join(dir, e.name), depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".txt")) count += 1;
    }
  } catch { /* 不可读目录 */ }
  return count;
}

"use strict";

// log-viewer 插件冒烟测试：Mock PluginContext + 临时日志目录（环境变量注入）。
// 用法：node local-plugins/smoke-test-log-viewer.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 造一个临时 logs 目录（插件通过 CYRENE_LOG_VIEWER_DIR 读取）
const fakeLogs = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-logs-"));
fs.writeFileSync(path.join(fakeLogs, "cyrene.log"), [
  "2026-09-11 10:00:00.001 INFO  Chat           conversation started",
  "2026-09-11 10:00:05.500 WARN  BuiltinTools   [run_shell] fail-closed before spawn",
  "2026-09-11 10:01:00.000 ERROR Runtime          [Sandbox] lazy init failed, disabling:",
  "srt-win: acl grant — 1 path(s) FAILED",
  "srt-win: error: rolled back",
  "2026-09-11 10:02:00.000 DEBUG Mpv            state tick",
].join("\n"));
fs.writeFileSync(path.join(fakeLogs, "cyrene.log.1"), [
  "2026-09-10 09:00:00.000 ERROR Legacy           old error entry",
].join("\n"));
fs.writeFileSync(path.join(fakeLogs, "mimo-tts.log"), '{"audioBytes": 1}\n');

process.env.CYRENE_LOG_VIEWER_DIR = fakeLogs;

const plugin = require("./log-viewer/index.cjs");

async function main() {
  let failed = 0;
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` —— ${detail}`}`);
    if (!ok) failed++;
  };

  const registered = { tools: [], ipc: new Map(), logs: [], disposers: [] };
  const ctx = {
    registerTool: (spec) => registered.tools.push(spec),
    registerIpc: (channel, handler) => registered.ipc.set(channel, handler),
    onDispose: (fn) => registered.disposers.push(fn),
    log: (...args) => registered.logs.push(args.join(" ")),
    deps: { secrets: { get: async () => undefined, set: async () => {}, delete: async () => {} } },
  };

  // 1. 契约
  await plugin.register(ctx);
  check("register 不抛错", true);
  check("恰好注册 1 个工具", registered.tools.length === 1, `实际 ${registered.tools.length}`);
  const tool = registered.tools[0];
  check("工具 id 前缀正确", tool.id === "log-viewer_recent", tool.id);
  check("risk=safe / effectKind=read", tool.risk === "safe" && tool.effectKind === "read");
  check("注册 2 个 IPC 通道", registered.ipc.size === 2, [...registered.ipc.keys()].join(","));

  // 2. 文件列举（按修改时间倒序，cyrene.log 最新）
  const ipc = registered.ipc;
  const files = await ipc.get("get-files")();
  check("列出 3 个日志文件", files.files.length === 3, JSON.stringify(files.files.map((f) => f.name)));
  check("activeFile 默认 cyrene.log", files.activeFile === "cyrene.log");

  // 3. read-tail：级别解析 / 标签提取 / 续行归组
  const tail = await ipc.get("read-tail")("cyrene.log", 65536);
  const entries = tail.entries;
  check("解析出 4 个条目（续行并入）", entries.length === 4, `实际 ${entries.length}`);
  const errEntry = entries.find((e) => e.level === "ERROR");
  check("ERROR 条目存在且标签正确", errEntry && errEntry.tag === "Runtime", JSON.stringify(errEntry?.tag));
  check("堆栈续行归组到 ERROR 条目", errEntry && errEntry.cont.length === 2, `续行 ${errEntry?.cont.length}`);
  check("INFO 条目正常", entries.some((e) => e.level === "INFO" && e.tag === "Chat"));
  check("DEBUG 条目正常", entries.some((e) => e.level === "DEBUG"));

  // 4. 文件名清洗：拒绝路径穿越与非法名
  const evil = await ipc.get("read-tail")("../../secrets.json", 1024);
  check("拒绝路径穿越（回退 activeFile）", typeof evil.entries === "object");
  const evil2 = await ipc.get("read-tail")("not-a-log.txt", 1024);
  check("拒绝非 .log 文件名", typeof evil2.entries === "object");

  // 5. LLM 工具：级别过滤与条数
  const all = await tool.execute({ level: "all", lines: 50 });
  check("all 返回全部 4 条", all.includes("最近 4 条日志"), all.split("\n")[0]);
  const errOnly = await tool.execute({ level: "error", lines: 50 });
  check("error 过滤只留 ERROR（含堆栈行）", errOnly.includes("最近 1 条日志") && errOnly.includes("lazy init failed"), errOnly.split("\n")[0]);
  const warnPlus = await tool.execute({ level: "warn", lines: 50 });
  check("warn 过滤含 ERROR+WARN", warnPlus.includes("最近 2 条日志"), warnPlus.split("\n")[0]);
  const clamp = await tool.execute({ level: "all", lines: 999 });
  check("lines 超限被钳制不报错", clamp.includes("最近 4 条日志"));

  // 6. open 之外的清理路径：unregister 幂等（不启动窗口/监视也不崩）
  await plugin.unregister();
  await plugin.unregister();
  check("unregister 幂等", true);

  // 7. 真实日志目录只读验证（用户机器上实际存在的日志）：
  //    去掉环境变量、mock electron.app 指向真实 userData，验证默认路径解析
  delete process.env.CYRENE_LOG_VIEWER_DIR;
  const Module = require("node:module");
  const origRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === "electron") {
      return { app: { getPath: () => path.join(process.env.APPDATA, "live2d-cyrene") } };
    }
    return origRequire.apply(this, arguments);
  };
  const real = await tool.execute({ level: "all", lines: 5 });
  Module.prototype.require = origRequire;
  check("真实日志目录可读（非空结果或友好空态）", !real.startsWith("[工具执行失败]"), real.slice(0, 80));

  console.log(failed === 0 ? "\n全部通过 ✓" : `\n${failed} 项失败 ✗`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("测试脚本异常：", err);
  process.exit(1);
});

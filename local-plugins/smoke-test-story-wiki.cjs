"use strict";

// story-wiki 插件冒烟测试：Mock ctx + 临时 wiki 目录（storage 注入路径）。
// 用法：node local-plugins/smoke-test-story-wiki.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 临时 wiki 数据：两个分类、三个文件，含 BWiki 模板标记
const wikiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-wiki-"));
fs.mkdirSync(path.join(wikiRoot, "角色"), { recursive: true });
fs.mkdirSync(path.join(wikiRoot, "开拓任务"), { recursive: true });
fs.writeFileSync(path.join(wikiRoot, "角色", "遐蝶.txt"),
  "{{角色图鉴\n|名称=遐蝶\n|称号=冥河的女儿\n|角色故事1=遐蝶诞生于哀地里亚的黄昏。\n}}\n<!-- 注释应被删除 -->\n{{黑幕|她与缇宝有约}}");
fs.writeFileSync(path.join(wikiRoot, "角色", "白厄.txt"),
  "{{角色图鉴\n|名称=白厄\n|角色故事1=白厄行于翁法罗斯的黄金之路。\n}}");
fs.writeFileSync(path.join(wikiRoot, "开拓任务", "再创世的凯歌.txt"),
  "开拓任务：再创世的凯歌。\n遐蝶在哀地里亚与白厄相遇，泰坦的阴影笼罩大地。\n<br>分隔行");

const plugin = require("./story-wiki/index.cjs");

async function main() {
  let failed = 0;
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` —— ${detail}`}`);
    if (!ok) failed++;
  };

  const storage = new Map();
  storage.set("wikiDir", wikiRoot);

  const registered = { tools: [], ipc: new Map(), logs: [] };
  const ctx = {
    registerTool: (spec) => registered.tools.push(spec),
    registerIpc: (channel, handler) => registered.ipc.set(channel, handler),
    onDispose: () => {},
    log: (...args) => registered.logs.push(args.join(" ")),
    storage: {
      get: (k) => storage.get(k),
      set: (k, v) => (v === undefined ? storage.delete(k) : storage.set(k, v)),
    },
    deps: {},
  };

  // 1. 契约
  await plugin.register(ctx);
  check("register 不抛错", true);
  check("恰好注册 1 个工具", registered.tools.length === 1);
  const tool = registered.tools[0];
  check("工具 id 前缀正确", tool.id === "story-wiki_search", tool.id);
  check("risk=safe / effectKind=read", tool.risk === "safe" && tool.effectKind === "read");
  check("注册 3 个 IPC 通道", registered.ipc.size === 3, [...registered.ipc.keys()].join(","));

  // 2. 参数校验
  const noQuery = await tool.execute({});
  check("缺 query 报错", noQuery.startsWith("[错误]"), noQuery.slice(0, 30));

  // 3. 标题命中 + BWiki 清洗
  const hit = await tool.execute({ query: "遐蝶" });
  check("标题命中遐蝶", hit.includes("【角色/遐蝶】"), hit.slice(0, 60));
  check("BWiki 模板清洗：字段名转换", hit.includes("名称：遐蝶") || hit.includes("遐蝶"), "");
  check("注释被清除", !hit.includes("注释应被删除"));
  check("黑幕展开为正文", hit.includes("她与缇宝有约"));
  check("含防编造引导语", hit.includes("不要编造"));

  // 4. 多关键词 + 分类过滤
  const multi = await tool.execute({ query: "遐蝶 哀地里亚" });
  check("多词命中正文", multi.includes("遐蝶") && multi.includes("哀地里亚"));
  const scoped = await tool.execute({ query: "遐蝶", category: "开拓任务" });
  check("分类过滤只搜指定类", scoped.includes("再创世的凯歌") && !scoped.includes("【角色/遐蝶】"), scoped.slice(0, 60));
  const miss = await tool.execute({ query: "不存在的关键词xyz" });
  check("无命中友好提示", miss.includes("没有找到"), miss.slice(0, 40));

  // 5. 状态 IPC
  const status = await registered.ipc.get("get-status")();
  check("get-status 返回索引信息", status.configured === true && status.docCount === 3, JSON.stringify({ n: status.docCount }));
  check("分类列表正确", JSON.stringify(status.categories.sort()) === JSON.stringify(["开拓任务", "角色"]), JSON.stringify(status.categories));

  // 6. 清除配置后错误友好
  await registered.ipc.get("clear-dir")();
  const cleared = await registered.ipc.get("get-status")();
  check("清除后 configured=false", cleared.configured === false);
  const noData = await tool.execute({ query: "遐蝶" });
  check("无数据返回设置引导", noData.includes("未找到剧情库数据目录") || noData.includes("[工具执行失败]"), noData.slice(0, 50));

  // 7. unregister 幂等
  await plugin.unregister();
  await plugin.unregister();
  check("unregister 幂等", true);

  console.log(failed === 0 ? "\n全部通过 ✓" : `\n${failed} 项失败 ✗`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("测试脚本异常：", err);
  process.exit(1);
});

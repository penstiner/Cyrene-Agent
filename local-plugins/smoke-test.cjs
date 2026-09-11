"use strict";

// 插件冒烟测试：Mock PluginContext，不启动 Electron。
// 用法：node local-plugins/smoke-test.cjs

const path = require("node:path");
const plugin = require("./zhipu-web-search/index.cjs");

const PLUGIN_ID = "zhipu-web-search";
const secretsStore = new Map();

const registered = { tools: [], ipc: new Map(), logs: [] };

const ctx = {
  registerTool(spec) {
    registered.tools.push(spec);
  },
  registerIpc(channel, handler) {
    registered.ipc.set(channel, handler);
  },
  log: (...args) => registered.logs.push(args.join(" ")),
  deps: {
    secrets: {
      get: async (key) => secretsStore.get(key),
      set: async (key, value) => secretsStore.set(key, value),
      delete: async (key) => secretsStore.delete(key),
    },
  },
};

async function main() {
  let failed = 0;
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` —— ${detail}`}`);
    if (!ok) failed++;
  };

  // 1. register 契约
  await plugin.register(ctx);
  check("register 不抛错", true);
  check("恰好注册 1 个工具", registered.tools.length === 1, `实际 ${registered.tools.length}`);
  const tool = registered.tools[0];
  check("工具 id 前缀正确", tool.id === `${PLUGIN_ID}_search`, tool.id);
  check("enabled=true", tool.enabled === true);
  check("risk/effectKind", tool.risk === "network" && tool.effectKind === "read");
  check("inputSchema.required 含 query", Array.isArray(tool.inputSchema.required) && tool.inputSchema.required.includes("query"));
  check("注册了 3 个 IPC 通道", registered.ipc.size === 3, [...registered.ipc.keys()].join(","));

  // 2. 无 Key 时友好降级
  const noKey = await tool.execute({ query: "今天的新闻" });
  check("无 Key 返回配置提示", noKey.includes("尚未配置智谱 API Key"), noKey.slice(0, 60));

  // 3. 缺参数
  const noQuery = await tool.execute({});
  check("缺 query 报错", noQuery.startsWith("[错误]"), noQuery.slice(0, 40));

  // 4. IPC：set-key 空 / 正常 / get-status / clear-key
  const emptySet = await registered.ipc.get("set-key")("   ");
  check("set-key 拒绝空值", emptySet.ok === false);
  await registered.ipc.get("set-key")("test-key-123");
  check("set-key 保存成功", (await registered.ipc.get("get-status")()).hasKey === true);
  check("secrets 收到去除空白后的 Key", secretsStore.get("zhipu_api_key") === "test-key-123");
  await registered.ipc.get("clear-key")();
  check("clear-key 后状态同步", (await registered.ipc.get("get-status")()).hasKey === false);

  // 5. unregister 可重复调用
  await plugin.unregister();
  await plugin.unregister();
  check("unregister 幂等", true);

  // 6. 真实请求（可选）：环境变量 ZHIPU_KEY 存在时打一次真接口
  if (process.env.ZHIPU_KEY) {
    secretsStore.set("zhipu_api_key", process.env.ZHIPU_KEY);
    const real = await tool.execute({ query: "人工智能 最新进展", count: 3 });
    const ok = real.includes("搜索结果") || real.includes("没有搜到");
    check("真实 API 调用", ok, real.slice(0, 120));
  } else {
    console.log("SKIP  真实 API 调用（未设置 ZHIPU_KEY 环境变量）");
  }

  console.log(failed === 0 ? "\n全部通过 ✓" : `\n${failed} 项失败 ✗`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("测试脚本异常：", err);
  process.exit(1);
});

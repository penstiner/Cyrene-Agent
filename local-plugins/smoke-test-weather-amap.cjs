"use strict";

// qweather + amap-explorer 插件冒烟测试：Mock PluginContext，不启动 Electron。
// 用法：node local-plugins/smoke-test-weather-amap.cjs

const qweather = require("./qweather/index.cjs");
const amapExplorer = require("./amap-explorer/index.cjs");

function makeCtx(pluginId) {
  const secrets = new Map();
  const registered = { tools: [], ipc: new Map(), logs: [] };
  const ctx = {
    registerTool: (spec) => registered.tools.push(spec),
    registerIpc: (channel, handler) => registered.ipc.set(channel, handler),
    log: (...args) => registered.logs.push(args.join(" ")),
    deps: {
      secrets: {
        get: async (key) => secrets.get(key),
        set: async (key, value) => secrets.set(key, value),
        delete: async (key) => secrets.delete(key),
      },
    },
  };
  return { ctx, registered, secrets, pluginId };
}

async function runPluginTests(plugin, pluginId, extraChecks) {
  let failed = 0;
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  [${pluginId}] ${name}${ok ? "" : ` —— ${detail}`}`);
    if (!ok) failed++;
  };
  const { ctx, registered } = makeCtx(pluginId);

  await plugin.register(ctx);
  check("register 不抛错", true);
  check("恰好注册 1 个工具", registered.tools.length === 1, `实际 ${registered.tools.length}`);
  const tool = registered.tools[0];
  check("工具 id 前缀正确", tool.id.startsWith(`${pluginId}_`), tool.id);
  check("risk=network / effectKind=read", tool.risk === "network" && tool.effectKind === "read");
  check("description 含场景说明", (tool.description ?? "").length > 40);

  // 无 Key 降级
  const noKey = await tool.execute({ city: "武汉", keywords: "咖啡" });
  check("无 Key 返回配置提示", noKey.includes("[提示]") && noKey.includes("尚未配置"), noKey.slice(0, 50));

  // unregister 幂等
  await plugin.unregister();
  await plugin.unregister();
  check("unregister 幂等", true);

  const extraFailed = extraChecks ? await extraChecks({ plugin, check, makeCtx }) : 0;
  return failed + extraFailed;
}

async function main() {
  let failed = 0;

  failed += await runPluginTests(qweather, "qweather", async ({ plugin, check, makeCtx }) => {
    let f = 0;
    const wrap = (name, ok, detail = "") => { check(name, ok, detail); if (!ok) f++; };
    const { ctx, registered, secrets } = makeCtx("qweather");
    await plugin.register(ctx);
    const ipc = registered.ipc;

    // set-config 参数校验（Host 是必填项，公共地址要拒绝）
    const noKey = await ipc.get("set-config")("", "https://abc.def.qweatherapi.com");
    wrap("set-config 拒绝空 Key", noKey.ok === false);
    const noHost = await ipc.get("set-config")("sk-test", "");
    wrap("set-config 拒绝空 Host", noHost.ok === false);
    const publicHost = await ipc.get("set-config")("sk-test", "https://devapi.qweather.com");
    wrap("set-config 拒绝公共 Host", publicHost.ok === false && String(publicHost.error).includes("专属"));
    const okSet = await ipc.get("set-config")("  sk-test  ", "https://abc123.def.qweatherapi.com/");
    wrap("set-config 保存成功（trim + 去尾斜杠）", okSet.ok === true
      && secrets.get("api_key") === "sk-test"
      && secrets.get("api_host") === "https://abc123.def.qweatherapi.com");
    const status = await ipc.get("get-status")();
    wrap("get-status 回读", status.hasKey === true && status.host === "https://abc123.def.qweatherapi.com");
    await ipc.get("clear-config")();
    wrap("clear-config 清两项", (await ipc.get("get-status")()).hasKey === false);

    // 只配 Key 不配 Host → 引导文案
    await secrets.set("api_key", "sk-test");
    const tool = registered.tools[0];
    const noHostQuery = await tool.execute({ city: "武汉" });
    wrap("缺 Host 返回专属地址引导", noHostQuery.includes("专属 API Host"), noHostQuery.slice(0, 50));

    // 参数校验
    const noCity = await tool.execute({});
    wrap("缺 city 报错", noCity.startsWith("[错误]"), noCity.slice(0, 40));
    return f;
  });

  failed += await runPluginTests(amapExplorer, "amap-explorer", async ({ plugin, check, makeCtx }) => {
    let f = 0;
    const wrap = (name, ok, detail = "") => { check(name, ok, detail); if (!ok) f++; };
    const { ctx, registered, secrets } = makeCtx("amap-explorer");
    await plugin.register(ctx);
    const ipc = registered.ipc;

    const emptySet = await ipc.get("set-key")("   ");
    wrap("set-key 拒绝空值", emptySet.ok === false);
    await ipc.get("set-key")("  amap-test-key  ");
    wrap("set-key 保存成功（trim）", secrets.get("api_key") === "amap-test-key");
    wrap("get-status 回读", (await ipc.get("get-status")()).hasKey === true);
    await ipc.get("clear-key")();
    wrap("clear-key 后状态同步", (await ipc.get("get-status")()).hasKey === false);

    const tool = registered.tools[0];
    const noKeywords = await tool.execute({});
    wrap("缺 keywords 报错", noKeywords.startsWith("[错误]"), noKeywords.slice(0, 40));
    return f;
  });

  console.log(failed === 0 ? "\n全部通过 ✓" : `\n${failed} 项失败 ✗`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("测试脚本异常：", err);
  process.exit(1);
});

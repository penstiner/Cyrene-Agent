"use strict";

// 智谱网络搜索插件 —— 移植自 Castorice-Agent 的 search_web 工具，
// 按 Cyrene 插件规范改造：registerTool + secrets 密钥 + open() 设置弹窗。
//
// 智谱 web_search：POST https://open.bigmodel.cn/api/paas/v4/web_search
//   Authorization: Bearer <key>
//   { search_query, search_engine: "search_std", search_intent: false, count, search_recency_filter }

const path = require("node:path");

const SEARCH_URL = "https://open.bigmodel.cn/api/paas/v4/web_search";
const SECRET_KEY = "zhipu_api_key";
const RECENCY = new Set(["noLimit", "oneDay", "oneWeek", "oneMonth", "oneYear"]);
const REQUEST_TIMEOUT_MS = 15_000;

let settingsWindow = null;

module.exports = {
  async register(ctx) {
    ctx.registerTool({
      id: "zhipu-web-search_search",
      name: "网络搜索",
      description:
        "搜索互联网获取实时信息（智谱搜索）。当用户问新闻、百科、实时事件、最新消息，" +
        "或让你「查一下」「搜一下」时使用。query 为搜索关键词（不超过 70 字符），" +
        "recency 可选时间范围，count 可选返回条数（默认 5，最大 10）。",
      enabled: true,
      risk: "network",
      effectKind: "read",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词，不超过 70 字符" },
          recency: {
            type: "string",
            enum: ["noLimit", "oneDay", "oneWeek", "oneMonth", "oneYear"],
            description: "时间范围过滤，默认 noLimit",
          },
          count: { type: "number", description: "返回条数，默认 5，最大 10" },
        },
        required: ["query"],
      },
      execute(args, toolCtx) {
        return runSearch(ctx, args, toolCtx);
      },
    });

    // 设置弹窗使用的私有 IPC（完整通道名 plugin:zhipu-web-search:*）
    ctx.registerIpc("get-status", async () => {
      const key = await ctx.deps.secrets.get(SECRET_KEY);
      return { hasKey: Boolean(key) };
    });
    ctx.registerIpc("set-key", async (rawKey) => {
      const key = String(rawKey ?? "").trim();
      if (!key) return { ok: false, error: "API Key 不能为空" };
      await ctx.deps.secrets.set(SECRET_KEY, key);
      ctx.log("API Key 已更新");
      return { ok: true };
    });
    ctx.registerIpc("clear-key", async () => {
      await ctx.deps.secrets.delete(SECRET_KEY);
      ctx.log("API Key 已清除");
      return { ok: true };
    });

    ctx.log("智谱网络搜索插件已注册");
  },

  async open() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.focus();
      return;
    }
    const { BrowserWindow } = require("electron");
    settingsWindow = new BrowserWindow({
      width: 440,
      height: 320,
      autoHideMenuBar: true,
      resizable: false,
      title: "智谱网络搜索 · 设置",
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });
    settingsWindow.on("closed", () => {
      settingsWindow = null;
    });
    await settingsWindow.loadFile(path.join(__dirname, "ui.html"));
  },

  async unregister() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.close();
    }
    settingsWindow = null;
  },
};

async function runSearch(ctx, args, toolCtx) {
  const query = String(args?.query ?? "").trim();
  if (!query) return "[错误] 缺少 query 参数";

  const recency = RECENCY.has(String(args?.recency)) ? String(args.recency) : "noLimit";
  const rawCount = Number(args?.count ?? 5);
  const count = Math.min(Math.max(Number.isFinite(rawCount) ? Math.trunc(rawCount) : 5, 1), 10);

  let key;
  try {
    key = await ctx.deps.secrets.get(SECRET_KEY);
  } catch (err) {
    return "[工具执行失败] 读取密钥失败（安全存储不可用）：请检查系统钥匙串后重试。";
  }
  if (!key) {
    return "[提示] 尚未配置智谱 API Key：请点击插件卡片的「打开」按钮填写后重试。" +
      "Key 在智谱开放平台 https://open.bigmodel.cn 的 API Keys 页面创建。";
  }

  const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
  if (toolCtx?.signal) signals.push(toolCtx.signal);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  let resp;
  try {
    resp = await fetch(SEARCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        search_query: query.slice(0, 70),
        search_engine: "search_std",
        search_intent: false,
        count,
        search_recency_filter: recency,
      }),
      signal,
    });
  } catch (err) {
    if (toolCtx?.signal?.aborted) return "[工具执行失败] 搜索已取消。";
    if (err?.name === "TimeoutError") {
      return `[工具执行失败] 搜索超时（${REQUEST_TIMEOUT_MS / 1000} 秒），请稍后重试。`;
    }
    return `[工具执行失败] 网络请求失败：${err instanceof Error ? err.message : String(err)}`;
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    ctx.log(`搜索接口返回 ${resp.status}`);
    let hint = "";
    if (resp.status === 401) hint = "（API Key 无效或已过期，请在插件设置中更新）";
    if (resp.status === 429) hint = "（调用频率超限，请稍后重试）";
    return `[工具执行失败] 搜索接口返回 ${resp.status}${hint}：${detail.slice(0, 120)}`;
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    return "[工具执行失败] 搜索接口返回了无法解析的内容。";
  }
  const results = Array.isArray(data?.search_result) ? data.search_result.slice(0, count) : [];
  if (results.length === 0) {
    return `没有搜到与「${query}」相关的内容，可以换个关键词再试。`;
  }

  const lines = [`「${query}」搜索结果：`];
  results.forEach((item, index) => {
    const date = item?.publish_date ? `（${item.publish_date}）` : "";
    const media = item?.media ? ` [${item.media}]` : "";
    lines.push(`${index + 1}. ${item?.title ?? "无标题"}${date}${media}`);
    const content = String(item?.content ?? "").slice(0, 200).trim();
    if (content) lines.push(`   ${content}`);
    if (item?.link) lines.push(`   链接：${item.link}`);
  });
  return lines.join("\n");
}

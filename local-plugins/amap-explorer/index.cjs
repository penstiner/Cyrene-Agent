"use strict";

// 高德周边探索插件 —— 移植自 Castorice-Agent 的 amap_poi 工具，按 Cyrene 插件规范改造。
//
// 高德 API 要点（restapi.amap.com/v3）：
// - Web 服务免费版 QPS 很低：全局信号量串行 + 请求间最小间隔节流，防限流
// - 服务端瞬时错误（ENGINE_RESPONSE_DATA_ERROR 等）自动重试
// - v3 空字段返回 []（空数组）而非空串，需按字符串校验
//
// 搜索两形态：关键词直接搜（/place/text）与周边搜索（/place/around，
// 中心地名先 geocode 解析坐标）。

const path = require("node:path");

const AMAP_BASE = "https://restapi.amap.com/v3";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CONCURRENCY = 1;
const MIN_INTERVAL_MS = 120;
const RETRYABLE_ERRORS = /ENGINE_RESPONSE_DATA_ERROR|SERVER_IS_BUSY|GATEWAY_TIMEOUT|UNKNOWN_ERROR/i;
const MAX_RETRIES = 2;

let settingsWindow = null;

module.exports = {
  async register(ctx) {
    ctx.registerTool({
      id: "amap-explorer_search",
      name: "地点搜索",
      description:
        "搜索地点/周边（高德数据源）。对方找餐厅、咖啡店、酒店、景点、好玩的好吃的地方时使用。" +
        "地点是实时检索结果：每次必须现场调用，绝不从历史或记忆里复用旧地点。" +
        "按关键词搜（如'杭州 咖啡店'）传 keywords；找某地附近（如'杭州东站附近的餐厅'）把中心地名传 center。" +
        "一次只调一个，不要并行。",
      enabled: true,
      risk: "network",
      effectKind: "read",
      inputSchema: {
        type: "object",
        properties: {
          keywords: { type: "string", description: "搜索关键词，如'咖啡店'、'川菜馆'、'景点'" },
          city: { type: "string", description: "限定城市（可选），如'杭州'" },
          center: {
            type: "string",
            description: "周边搜索的中心地名（用户说的，如'杭州东站'；可选）。传了它就不必传 location，工具自己解析坐标。",
          },
          radius: { type: "number", description: "周边搜索半径（米），默认 1000，最大 50000" },
        },
        required: ["keywords"],
      },
      execute(args, toolCtx) {
        return runSearch(ctx, args, toolCtx);
      },
    });

    ctx.registerIpc("get-status", async () => {
      const key = await ctx.deps.secrets.get("api_key");
      return { hasKey: Boolean(key) };
    });
    ctx.registerIpc("set-key", async (rawKey) => {
      const key = String(rawKey ?? "").trim();
      if (!key) return { ok: false, error: "API Key 不能为空" };
      await ctx.deps.secrets.set("api_key", key);
      ctx.log("API Key 已更新");
      return { ok: true };
    });
    ctx.registerIpc("clear-key", async () => {
      await ctx.deps.secrets.delete("api_key");
      ctx.log("API Key 已清除");
      return { ok: true };
    });

    ctx.log("高德周边探索插件已注册");
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
      title: "高德周边探索 · 设置",
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

// ── 节流（信号量串行 + 最小间隔；移植自 Castorice）──

let permits = MAX_CONCURRENCY;
let queue = [];
let lastRequestAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquirePermit() {
  if (permits > 0) {
    permits -= 1;
  } else {
    await new Promise((resolve) => queue.push(resolve));
  }
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_INTERVAL_MS) await sleep(MIN_INTERVAL_MS - elapsed);
}

function releasePermit() {
  const next = queue.shift();
  if (next) next();
  else permits += 1;
}

// ── API 客户端 ──

async function getAmapKey(ctx) {
  try {
    return (await ctx.deps.secrets.get("api_key")) || "";
  } catch {
    return "";
  }
}

async function amapGet(ctx, key, pathname, params, toolCtx, silent = false) {
  for (let attempt = 0; ; attempt += 1) {
    await acquirePermit();
    try {
      const url = new URL(`${AMAP_BASE}${pathname}`);
      url.search = new URLSearchParams({ ...params, key }).toString();
      const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
      if (toolCtx?.signal) signals.push(toolCtx.signal);
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      const resp = await fetch(url, { signal });
      if (!resp.ok) {
        throw new Error(`高德接口返回 ${resp.status}`);
      }
      const data = await resp.json();
      if (data.status !== "1") {
        const info = String(data.info ?? "");
        if (RETRYABLE_ERRORS.test(info) && attempt < MAX_RETRIES) {
          await sleep(300 * (attempt + 1));
          continue;
        }
        if (!silent) ctx.log(`高德接口业务失败：${info}（attempt ${attempt}）`);
        throw new Error(`高德接口出错：${info}`);
      }
      return data;
    } finally {
      lastRequestAt = Date.now();
      releasePermit();
    }
  }
}

/** 地址 → { location: "lng,lat", formatted }；找不到返回 null。 */
async function geocode(ctx, key, address, city, toolCtx) {
  const params = { address };
  if (city) params.city = city;
  const data = await amapGet(ctx, key, "/geocode/geo", params, toolCtx, true);
  const g = (data.geocodes ?? [])[0];
  if (!g?.location) return null;
  return { location: g.location, formatted: g.formatted_address ?? address };
}

/** 逆地理编码：经纬度 → 简短地名（最近 POI > 市+区 > formatted 尾部）；失败返回 null。 */
async function regeocode(ctx, key, location, toolCtx) {
  try {
    const data = await amapGet(ctx, key, "/regeo", { location, extensions: "base" }, toolCtx, true);
    const re = data.regeocode;
    const poiName = (re?.pois ?? [])[0]?.name;
    if (poiName) return poiName;
    const comp = re?.addressComponent;
    const city = comp?.city && comp.city !== "[]" ? comp.city : comp?.province ?? "";
    const district = comp?.district && comp.district !== "[]" ? comp.district : "";
    if (city || district) return `${city}${district}`;
    const fa = re?.formatted_address;
    if (fa) return fa.replace(/^.*?省/, "").replace(/^.*?市/, "").trim().slice(0, 12) || fa.slice(0, 12);
    return null;
  } catch {
    return null;
  }
}

// ── 渲染 ──

function formatPois(pois, title) {
  if (!pois || pois.length === 0) return "没有找到符合条件的地点，换个关键词试试。";
  const lines = [title];
  pois.slice(0, 8).forEach((p, i) => {
    const dist = typeof p.distance === "string" && p.distance ? `（约${p.distance}米）` : "";
    const addr = typeof p.address === "string" && p.address ? ` · ${p.address}` : "";
    const type = typeof p.type === "string" && p.type ? ` [${p.type.split(";")[0]}]` : "";
    lines.push(`${i + 1}. ${p.name ?? "未知"}${dist}${type}${addr}`);
  });
  return lines.join("\n");
}

// ── 主流程 ──

async function runSearch(ctx, args, toolCtx) {
  const keywords = String(args?.keywords ?? "").trim();
  const city = String(args?.city ?? "").trim();
  const centerName = String(args?.center ?? "").trim();
  const rawRadius = Number(args?.radius ?? 1000);
  const radius = Number.isFinite(rawRadius) ? Math.min(Math.max(Math.trunc(rawRadius), 100), 50_000) : 1000;

  if (!keywords) return "[错误] 缺少 keywords 参数";

  const key = await getAmapKey(ctx);
  if (!key) {
    return "[提示] 尚未配置高德地图 API Key：请点击插件卡片的「打开」按钮填写。" +
      "Key 在高德开放平台（console.amap.com）创建 Web 服务类型 Key。";
  }

  try {
    // 周边搜索：center（地名）提供即走
    if (centerName) {
      const g = await geocode(ctx, key, centerName, city, toolCtx);
      if (!g) return `[错误] 没解析出中心点「${centerName}」的位置，换个地名试试。`;
      const data = await amapGet(ctx, key, "/place/around", {
        keywords,
        location: g.location,
        radius: String(radius),
        offset: "8",
        page: "1",
      }, toolCtx);
      const pois = data.pois ?? [];
      return formatPois(pois, `「${centerName}」附近 ${radius} 米内的「${keywords}」：`);
    }

    // 关键词搜索
    const params = { keywords, offset: "8", page: "1" };
    if (city) params.city = city;
    const data = await amapGet(ctx, key, "/place/text", params, toolCtx);
    const pois = data.pois ?? [];
    const cityLabel = city ? `${city}的` : "";
    return formatPois(pois, `${cityLabel}「${keywords}」搜索结果：`);
  } catch (err) {
    if (toolCtx?.signal?.aborted) return "[工具执行失败] 搜索已取消。";
    if (err?.name === "TimeoutError") return `[工具执行失败] 高德接口超时（${REQUEST_TIMEOUT_MS / 1000} 秒），请稍后重试。`;
    ctx.log(`地点搜索失败：${err instanceof Error ? err.message : String(err)}`);
    return `[工具执行失败] ${err instanceof Error ? err.message : String(err)}`;
  }
}

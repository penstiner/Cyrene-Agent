"use strict";

// 和风天气插件 —— 移植自 Castorice-Agent 的 qweather_weather 工具，按 Cyrene 插件规范改造。
//
// 和风 API 要点（2026 年起）：
// - 公共地址 devapi/api/geoapi.qweather.com 已停用，必须用控制台的专属 API Host
// - 请求必须带 User-Agent，否则 403；认证走 X-QW-Api-Key 头 + key 参数双保险
// - 空气质量用新接口 airquality/v1/current/{lat}/{lon}（旧 /v7/air/now 已废弃）
//
// 查询两步走：城市名 → LocationID（GeoAPI）→ 对应数据。

const path = require("node:path");

const DEFAULT_HOST_PLACEHOLDER = "https://devapi.qweather.com";
const REQUEST_TIMEOUT_MS = 10_000;
const WEEK_LABEL = { "0": "周日", "1": "周一", "2": "周二", "3": "周三", "4": "周四", "5": "周五", "6": "周六", "7": "周日" };

const UA = "Cyrene-Plugin-QWeather/0.1.0 (Electron; weather)";

let settingsWindow = null;

module.exports = {
  async register(ctx) {
    ctx.registerTool({
      id: "qweather_weather",
      name: "天气查询",
      description:
        "查询指定城市/区县的详细天气（和风数据源）。对方问天气、温度、体感、下雨、刮风、湿度、空气质量、生活指数、穿衣、未来三天时使用。" +
        "天气实时变化：即使刚查过也必须重新调用，绝不凭记忆作答。" +
        "type='now' 实时；'forecast' 预报（days='3' 查未来三天，targetDay 配合 days='1' 查具体某天）；'air' 空气质量；'life' 生活指数。",
      enabled: true,
      risk: "network",
      effectKind: "read",
      inputSchema: {
        type: "object",
        properties: {
          city: {
            type: "string",
            description: "位置名称，支持到区县级：如'北京'、'武汉市武昌区'、'湖北省 武汉市 武昌区'。对方说了区/县就带上市一起传，精度更高。",
          },
          type: {
            type: "string",
            enum: ["now", "forecast", "air", "life"],
            description: "'now'=实时（默认），'forecast'=预报，'air'=空气质量，'life'=生活指数",
          },
          days: {
            type: "string",
            enum: ["1", "3"],
            description: "预报天数：'1'=单日（默认），'3'=未来三天（对方问未来几天时用）",
          },
          targetDay: {
            type: "string",
            enum: ["today", "tomorrow", "dayafter"],
            description: "目标日期（配合 days='1'）：'today'=今天，'tomorrow'=明天，'dayafter'=后天",
          },
        },
        required: ["city"],
      },
      execute(args, toolCtx) {
        return runWeather(ctx, args, toolCtx);
      },
    });

    ctx.registerIpc("get-status", async () => {
      const key = await ctx.deps.secrets.get("api_key");
      const host = await ctx.deps.secrets.get("api_host");
      return { hasKey: Boolean(key), host: host ?? "" };
    });
    ctx.registerIpc("set-config", async (rawKey, rawHost) => {
      const key = String(rawKey ?? "").trim();
      const host = String(rawHost ?? "").trim().replace(/\/+$/, "");
      if (!key) return { ok: false, error: "API Key 不能为空" };
      if (!host) return { ok: false, error: "API Host 不能为空" };
      if (/devapi\.qweather\.com|api\.qweather\.com$|geoapi\.qweather\.com/.test(host)) {
        return { ok: false, error: "公共地址已停用，请填控制台的专属 API Host（形如 abc123.def.qweatherapi.com）" };
      }
      await ctx.deps.secrets.set("api_key", key);
      await ctx.deps.secrets.set("api_host", host);
      ctx.log("和风天气配置已更新");
      return { ok: true };
    });
    ctx.registerIpc("clear-config", async () => {
      await ctx.deps.secrets.delete("api_key");
      await ctx.deps.secrets.delete("api_host");
      ctx.log("和风天气配置已清除");
      return { ok: true };
    });

    ctx.log("和风天气插件已注册");
  },

  async open() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.focus();
      return;
    }
    const { BrowserWindow } = require("electron");
    settingsWindow = new BrowserWindow({
      width: 480,
      height: 400,
      autoHideMenuBar: true,
      resizable: false,
      title: "和风天气 · 设置",
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

// ── API 客户端 ──

async function getConfig(ctx) {
  try {
    const [key, host] = await Promise.all([
      ctx.deps.secrets.get("api_key"),
      ctx.deps.secrets.get("api_host"),
    ]);
    return { key: key || "", host: (host || "").trim().replace(/\/+$/, "") };
  } catch {
    return { key: "", host: "" };
  }
}

function errorText(code, status) {
  if (code === "401" || status === 401) return "和风天气返回 401：API Key 无效或未生效，请检查插件设置中的 Key。";
  if (code === "402" || status === 402) return "和风天气返回 402：当前 Key 没有该接口的访问权限（免费版可能不支持此接口）。";
  if (code === "403" || status === 403) {
    return "和风天气返回 403：公共 API 地址已停用，请在插件设置里填写你的专属 API Host（和风控制台 console.qweather.com → 设置，形如 abc123.def.qweatherapi.com）。";
  }
  return code ? `和风天气接口出错（code=${code}）` : `和风天气接口返回 ${status}`;
}

async function qweatherGet(ctx, host, key, pathname, params, toolCtx) {
  const url = new URL(`${host}${pathname}`);
  url.search = new URLSearchParams({ ...params, key }).toString();
  const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
  if (toolCtx?.signal) signals.push(toolCtx.signal);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, "X-QW-Api-Key": key },
    signal,
  });
  if (!resp.ok) {
    let data = {};
    try { data = await resp.json(); } catch { /* 非 JSON */ }
    throw new Error(errorText(String(data.code ?? ""), resp.status));
  }
  const data = await resp.json();
  if (data.code !== undefined && data.code !== "200") {
    throw new Error(errorText(String(data.code), 200));
  }
  return data;
}

// ── 城市定位（多级查询解析 + 候选打分，移植自 Castorice）──

function stripAdminSuffix(name) {
  return name.replace(/(省|自治区|特别行政区|市|区|县|旗|自治州|自治县|县级市)$/u, "").trim() || name;
}

function splitLocationQuery(query) {
  const parts = String(query).split(/[\s,，、/]+/u).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 1) {
    const segs = parts[0].replace(/(省|自治区|市|自治州)/gu, "$1\u0001").split("\u0001").map((s) => s.trim()).filter(Boolean);
    if (segs.length > 1) {
      parts.length = 0;
      parts.push(...segs);
    }
  }
  const target = parts.length > 0 ? parts[parts.length - 1] : String(query).trim();
  const admTokens = parts.slice(0, -1).map(stripAdminSuffix).filter(Boolean);
  return { target, adm: admTokens.join(","), admTokens };
}

function pickBestLocation(target, admTokens, locations) {
  if (!locations || locations.length === 0) return null;
  const t = stripAdminSuffix(target);
  let best = null;
  let bestScore = -Infinity;
  locations.forEach((loc, rank) => {
    let score = 0;
    if (loc.name === target || loc.name === t) score += 10;
    else if (String(loc.name ?? "").startsWith(t)) score += 4;
    const hay = `${loc.adm1 ?? ""}${loc.adm2 ?? ""}`;
    for (const token of admTokens) {
      if (token && hay.includes(token)) score += 5;
      else if (token && String(loc.name ?? "").includes(token)) score += 3;
    }
    score -= rank;
    if (score > bestScore) { bestScore = score; best = loc; }
  });
  return best;
}

function locationFullName(loc) {
  const adm2 = loc.adm2 && loc.adm2 !== loc.name && loc.adm2 !== loc.adm1 ? loc.adm2 : "";
  return `${loc.adm1 ?? ""}${adm2}${loc.name ?? ""}`.trim() || (loc.name ?? loc.id);
}

async function cityToLocationId(ctx, host, key, city, toolCtx) {
  const { target, adm } = splitLocationQuery(city);
  const params = { location: target };
  if (adm) params.adm = adm;
  const data = await qweatherGet(ctx, host, key, "/geo/v2/city/lookup", params, toolCtx);
  const locations = data.location ?? [];
  const loc = pickBestLocation(target, splitLocationQuery(city).admTokens, locations);
  if (!loc?.id) return null;
  return { id: loc.id, name: loc.name ?? city, fullName: locationFullName(loc), lat: loc.lat ?? "", lon: loc.lon ?? "" };
}

// ── 空气质量（新接口，失败降级为 null）──

async function qweatherGetAir(host, key, lat, lon, toolCtx) {
  if (!lat || !lon || !key) return null;
  try {
    const url = new URL(`${host}/airquality/v1/current/${lat}/${lon}`);
    url.search = new URLSearchParams({ key }).toString();
    const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
    if (toolCtx?.signal) signals.push(toolCtx.signal);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const resp = await fetch(url, { headers: { "User-Agent": UA, "X-QW-Api-Key": key }, signal });
    if (!resp.ok) return null;
    const data = await resp.json();
    const idx = (data.indexes ?? []).find((i) => i.code === "qaqi") ?? (data.indexes ?? [])[0];
    const find = (code) => (data.pollutants ?? []).find((p) => p.code === code)?.concentration?.value;
    const pm25 = find("pm2p5");
    const pm10 = find("pm10");
    return {
      aqi: idx?.aqiDisplay ?? "",
      category: idx?.category ?? "",
      primary: idx?.primaryPollutant?.name ?? "",
      pm2p5: pm25 != null ? String(pm25) : "",
      pm10: pm10 != null ? String(pm10) : "",
    };
  } catch {
    return null;
  }
}

// ── 渲染 ──

function renderNow(now, fullName, air) {
  const windDir = String(now.windDir ?? "").replace(/风$/u, "");
  const wind = `${windDir}风${now.windScale ?? ""}级`.trim();
  const lines = [
    `${fullName} 实时天气（和风）：`,
    `天气：${now.text ?? "未知"}`,
    `温度：${now.temp ?? "?"}°C`,
    now.feelsLike ? `体感：${now.feelsLike}°C` : "",
    now.humidity ? `湿度：${now.humidity}%` : "",
    wind ? `风力：${wind}` : "",
    now.precip && Number(now.precip) > 0 ? `降水：${now.precip} mm` : "",
    now.pressure ? `气压：${now.pressure} hPa` : "",
    now.vis ? `能见度：${now.vis} km` : "",
  ];
  if (air && air.aqi) {
    lines.push(`空气质量：AQI ${air.aqi}${air.category ? `（${air.category}）` : ""}${air.primary ? `，首要污染物 ${air.primary}` : ""}`);
  }
  if (now.obsTime) lines.push(`（${now.obsTime} 更新）`);
  return lines.filter(Boolean).join("\n");
}

function renderForecast(daily, fullName, days, targetDay) {
  const desc = (d) =>
    `${WEEK_LABEL[String(new Date(d.fxDate ?? "").getDay())] ?? ""} ${d.fxDate ?? ""}：白天${d.textDay ?? "?"} ${d.tempMax ?? "?"}°C，夜间${d.textNight ?? "?"} ${d.tempMin ?? "?"}°C` +
    (d.windDirDay || d.windScaleDay ? `，${String(d.windDirDay ?? "").replace(/风$/u, "")}风${d.windScaleDay ?? ""}级` : "") +
    (d.precip && Number(d.precip) > 0 ? `（降水 ${d.precip} mm）` : "");
  if (days === 1) {
    const idx = targetDay === "today" ? 0 : targetDay === "dayafter" ? 2 : 1;
    const d = daily[idx] ?? daily[0];
    const label = targetDay === "today" ? "今天" : targetDay === "dayafter" ? "后天" : "明天";
    return `${fullName} ${label}（${d.fxDate ?? ""}）预报（和风）：\n${desc(d)}`;
  }
  const lines = [`${fullName} 未来 3 天预报（和风）：`];
  for (const d of daily.slice(0, 3)) lines.push(desc(d));
  return lines.join("\n");
}

function renderAir(air, fullName) {
  return [
    `${fullName} 空气质量（和风）：`,
    `AQI ${air.aqi ?? "?"}（${air.category ?? "未知"}）`,
    air.primary ? `首要污染物：${air.primary}` : "",
    `PM2.5：${air.pm2p5 || "-"} μg/m³`,
    `PM10：${air.pm10 || "-"} μg/m³`,
  ].filter(Boolean).join("\n");
}

function renderIndices(daily, fullName) {
  const lines = [`${fullName} 生活指数（和风）：`];
  for (const d of (daily ?? []).slice(0, 6)) {
    if (d.name && d.category) lines.push(`· ${d.name}：${d.category}——${d.text ?? ""}`);
  }
  return lines.join("\n");
}

// ── 主流程 ──

async function runWeather(ctx, args, toolCtx) {
  const city = String(args?.city ?? "").trim();
  if (!city) return "[错误] 缺少 city 参数";
  const type = ["forecast", "air", "life"].includes(args?.type) ? args.type : "now";
  const days = args?.days === "3" ? 3 : 1;
  const targetDay = ["today", "tomorrow", "dayafter"].includes(args?.targetDay) ? args.targetDay : undefined;

  const { key, host } = await getConfig(ctx);
  if (!key) {
    return "[提示] 尚未配置和风天气 API Key：请点击插件卡片的「打开」按钮填写。Key 与专属 API Host 在和风控制台（console.qweather.com）获取。";
  }
  if (!host || /devapi\.qweather\.com|geoapi\.qweather\.com/.test(host)) {
    return "[提示] 和风天气需要专属 API Host（公共地址已停用）：请在插件设置里填写控制台提供的地址，形如 abc123.def.qweatherapi.com。";
  }

  try {
    const loc = await cityToLocationId(ctx, host, key, city, toolCtx);
    if (!loc) return `[错误] 没找到城市「${city}」，换个名字试试。`;

    if (type === "forecast") {
      const data = await qweatherGet(ctx, host, key, "/v7/weather/3d", { location: loc.id }, toolCtx);
      const daily = data.daily ?? [];
      if (!daily.length) return `[错误] 「${loc.fullName}」的天气预报暂时查不到。`;
      return renderForecast(daily, loc.fullName, days, targetDay);
    }
    if (type === "air") {
      const air = await qweatherGetAir(host, key, loc.lat, loc.lon, toolCtx);
      if (!air || !air.aqi) return `[错误] 「${loc.fullName}」的空气质量暂时查不到。`;
      return renderAir(air, loc.fullName);
    }
    if (type === "life") {
      const data = await qweatherGet(ctx, host, key, "/v7/indices/1d", { location: loc.id, type: "0" }, toolCtx);
      const daily = data.daily ?? [];
      if (!daily.length) return `[错误] 「${loc.fullName}」的生活指数暂时查不到。`;
      return renderIndices(daily, loc.fullName);
    }

    const [data, air] = await Promise.all([
      qweatherGet(ctx, host, key, "/v7/weather/now", { location: loc.id }, toolCtx),
      qweatherGetAir(host, key, loc.lat, loc.lon, toolCtx),
    ]);
    const now = data.now;
    if (!now) return `[错误] 「${loc.fullName}」的实时天气暂时查不到。`;
    return renderNow(now, loc.fullName, air);
  } catch (err) {
    if (toolCtx?.signal?.aborted) return "[工具执行失败] 查询已取消。";
    if (err?.name === "TimeoutError") return `[工具执行失败] 和风接口超时（${REQUEST_TIMEOUT_MS / 1000} 秒），请稍后重试。`;
    ctx.log(`天气查询失败：${err instanceof Error ? err.message : String(err)}`);
    return `[工具执行失败] ${err instanceof Error ? err.message : String(err)}`;
  }
}

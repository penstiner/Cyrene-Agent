"use strict";

// 云端模式贴纸链路端到端验证（复现用户场景）：
// createOpenAIEmbeddingProvider（维度留空）→ getEmbeddingProviderIdentity（修复点）
// → buildCachedStickerEmbeddingIndex（真实 API 建索引）→ matchSticker（真实匹配）。
// Key 从 Castorice 配置读取，只在内存中使用，不回显。

const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("F:/Castorice-Agent/data/castorice.db", { readOnly: true });
const emb = JSON.parse(db.prepare(`SELECT value FROM settings WHERE key = 'embedding'`).get().value);
db.close();

const { createOpenAIEmbeddingProvider, getEmbeddingProviderIdentity } = require("../dist/main/main/rag/embedding.js");
const { buildCachedStickerEmbeddingIndex } = require("../dist/main/main/sticker-embedding-cache.js");
const { matchSticker } = require("../dist/main/main/sticker-embedder.js");
const { BUILT_IN_STICKER_DESCRIPTIONS } = require("../dist/main/main/sticker-descriptions.js");
const fs = require("node:fs");

// 维度留空（用户场景）：declaredDimensions = undefined
const provider = createOpenAIEmbeddingProvider(emb.baseUrl, emb.apiKey, "BAAI/bge-m3", undefined);

(async () => {
  // 修复点：身份解析（旧代码在这里抛 "dimensions not yet resolved"）
  const identity = await getEmbeddingProviderIdentity(provider);
  console.log(`[1] identity 解析成功: ${identity.provider} / ${identity.model} / ${identity.dimensions} 维`);

  // 建贴纸索引（真实批量 API）
  const cacheDir = fs.mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "sticker-cache-"));
  const index = await buildCachedStickerEmbeddingIndex(provider, BUILT_IN_STICKER_DESCRIPTIONS, {}, cacheDir);
  console.log(`[2] 贴纸索引构建成功: ${index.length} 条`);

  // 模拟一轮对话的匹配（回复 + 用户输入）
  const { buildStickerEmbeddingQuery } = require("../dist/main/main/sticker-query.js");
  const query = buildStickerEmbeddingQuery("好的，这个问题就交给我吧，保证给你办得妥妥的！", "你能帮我个忙吗");
  const matched = await matchSticker(query, provider, index, 0.55);
  console.log(`[3] 匹配结果: ${matched ? `${matched.id}（得分 ${matched.score.toFixed(3)}）` : "无（低于阈值）"}`);

  console.log(matched ? "\n云端贴纸链路端到端验证通过 ✓" : "\n索引正常但本轮未达阈值（属于正常语义判断）");
  process.exit(0);
})().catch((err) => {
  console.error("[FAIL]", err.message.slice(0, 300));
  process.exit(1);
});

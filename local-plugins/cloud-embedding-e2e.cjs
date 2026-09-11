"use strict";

// 端到端验证补丁链路：normalizeModelSettings（新字段解析）→ getEmbeddingProvider("cloud")
// → 真实调用硅基流动 /embeddings。Key 从 Castorice 配置读取，只在内存中使用，不回显。
// 用法：node local-plugins/cloud-embedding-e2e.cjs

const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync("F:/Castorice-Agent/data/castorice.db", { readOnly: true });
const row = db.prepare(`SELECT value FROM settings WHERE key = 'embedding'`).get();
db.close();
const castoriceEmbedding = JSON.parse(row.value);
console.log(`[setup] 已读取 Castorice embedding 配置：baseUrl 长度 ${castoriceEmbedding.baseUrl.length}，key 长度 ${castoriceEmbedding.apiKey.length}`);

const { normalizeModelSettings } = require("../dist/main/main/settings/model-settings.js");
const { getEmbeddingProvider } = require("../dist/main/main/rag/embedding.js");

// 1. 模拟设置界面保存的配置走主进程解析
const normalized = normalizeModelSettings({
  embeddingMode: "cloud",
  embeddingCloud: {
    baseUrl: castoriceEmbedding.baseUrl,
    apiKey: castoriceEmbedding.apiKey,
    model: castoriceEmbedding.model || "BAAI/bge-m3",
  },
  embeddingDimensions: undefined,
});
console.log(`[1] 解析结果: mode=${normalized.embeddingMode}, cloud.baseUrl=${normalized.embeddingCloud.baseUrl}, cloud.model=${normalized.embeddingCloud.model}`);

// 2. 模拟 initRag 的云端接线
const cloud = normalized.embeddingMode === "cloud" ? normalized.embeddingCloud : undefined;
if (!cloud) {
  console.error("[FAIL] 云端配置解析后丢失");
  process.exit(1);
}
const provider = getEmbeddingProvider("cloud", cloud.baseUrl, cloud.apiKey, cloud.model, undefined);
console.log(`[2] Provider: ${provider.name}`);

// 3. 真实向量化
provider
  .embed("今天天气怎么样？我们下午去公园散步吧。")
  .then((vec) => {
    console.log(`[3] 真实向量化成功：维度 ${vec.length}，前 3 分量 [${vec.slice(0, 3).map((n) => n.toFixed(4)).join(", ")}]`);
    console.log(vec.length === 1024 ? "\n端到端验证通过 ✓（bge-m3 = 1024 维）" : `\n注意：维度 ${vec.length} ≠ 1024`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("[FAIL] 向量化失败：", err.message.slice(0, 200));
    process.exit(1);
  });

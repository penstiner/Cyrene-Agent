"use strict";

// 复现"云端配置重启后丢失"：用安装包同款 dist 代码做 saveModelSettings → loadModelSettings 往返。
const Module = require("node:module");
const origRequire = Module.prototype.require;
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const fakeUserData = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-roundtrip-"));
Module.prototype.require = function (id) {
  if (id === "electron") {
    return { app: { getPath: () => fakeUserData } };
  }
  return origRequire.apply(this, arguments);
};

const { saveModelSettings, loadModelSettings } = require("../dist/main/main/settings/model-settings.js");

const patch = {
  embeddingMode: "cloud",
  embeddingCloud: { baseUrl: "https://api.siliconflow.cn/v1", apiKey: "sk-test-roundtrip", model: "BAAI/bge-m3" },
  embeddingDimensions: undefined,
};

const afterSave = saveModelSettings(patch);
console.log("[1] saveModelSettings 返回:", JSON.stringify({
  mode: afterSave.embeddingMode,
  cloud: afterSave.embeddingCloud,
}));

// 模拟重启：直接重新从磁盘加载
const reloaded = loadModelSettings();
console.log("[2] 重启后 loadModelSettings:", JSON.stringify({
  mode: reloaded.embeddingMode,
  cloud: reloaded.embeddingCloud,
}));

const rawFile = JSON.parse(fs.readFileSync(path.join(fakeUserData, "model-settings.json"), "utf8"));
console.log("[3] 磁盘文件:", JSON.stringify({ mode: rawFile.embeddingMode, cloud: rawFile.embeddingCloud }));

const ok = reloaded.embeddingMode === "cloud" && reloaded.embeddingCloud?.apiKey === "sk-test-roundtrip";
console.log(ok ? "\n往返通过 ✓（丢失发生在别处）" : "\n往返失败 ✗ —— 复现了丢失 bug");
process.exit(ok ? 0 : 1);

// embeddingCloud / embeddingMode 配置解析的回归测试：
// 云端 OpenAI 兼容 /embeddings（如硅基流动）配置的清洗规则 ——
// baseUrl+apiKey 齐全才生效；model 缺省 BAAI/bge-m3；baseUrl 去尾斜杠；模式白名单。
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/cyrene-test" } }));

import { normalizeModelSettings } from "./model-settings";

const MINIMAX_BASE = {
  provider: "MiniMax（稀宇科技）",
  baseUrl: "https://api.minimaxi.com/anthropic",
  model: "MiniMax-M3",
  apiKey: "sk-test",
  explicitTransport: "anthropic",
} as const;

function makeSettings(overrides: Record<string, unknown> = {}) {
  return normalizeModelSettings({ ...MINIMAX_BASE, ...overrides });
}

describe("embeddingMode / embeddingCloud 解析", () => {
  it("默认 auto 模式，无云端配置", () => {
    const s = makeSettings();
    expect(s.embeddingMode).toBe("auto");
    expect(s.embeddingCloud).toBeUndefined();
  });

  it("cloud 模式 + 齐全配置 → 原样保留，baseUrl 去尾斜杠", () => {
    const s = makeSettings({
      embeddingMode: "cloud",
      embeddingCloud: {
        baseUrl: "https://api.siliconflow.cn/v1/",
        apiKey: "sk-sf",
        model: "BAAI/bge-m3",
      },
    });
    expect(s.embeddingMode).toBe("cloud");
    expect(s.embeddingCloud?.baseUrl).toBe("https://api.siliconflow.cn/v1");
    expect(s.embeddingCloud?.apiKey).toBe("sk-sf");
    expect(s.embeddingCloud?.model).toBe("BAAI/bge-m3");
  });

  it("model 缺省 → BAAI/bge-m3（硅基流动免费档）", () => {
    const s = makeSettings({
      embeddingMode: "cloud",
      embeddingCloud: { baseUrl: "https://api.siliconflow.cn/v1", apiKey: "sk-sf" },
    });
    expect(s.embeddingCloud?.model).toBe("BAAI/bge-m3");
  });

  it("apiKey 缺失 → embeddingCloud 丢弃", () => {
    const s = makeSettings({
      embeddingMode: "cloud",
      embeddingCloud: { baseUrl: "https://api.siliconflow.cn/v1", apiKey: "  " },
    });
    expect(s.embeddingCloud).toBeUndefined();
  });

  it("baseUrl 缺失 → embeddingCloud 丢弃", () => {
    const s = makeSettings({
      embeddingMode: "cloud",
      embeddingCloud: { apiKey: "sk-sf" },
    });
    expect(s.embeddingCloud).toBeUndefined();
  });

  it("非法 embeddingMode 值 → 回落 auto（配置保留待用户修正）", () => {
    const s = makeSettings({
      embeddingMode: "local-only",
      embeddingCloud: { baseUrl: "https://api.siliconflow.cn/v1", apiKey: "sk-sf" },
    });
    expect(s.embeddingMode).toBe("auto");
    expect(s.embeddingCloud).toBeDefined();
  });

  it("非对象 embeddingCloud → 丢弃不抛错", () => {
    const s = makeSettings({
      embeddingMode: "cloud",
      embeddingCloud: "https://not-an-object",
    });
    expect(s.embeddingCloud).toBeUndefined();
  });

  it("apiKey 首尾空白被裁剪", () => {
    const s = makeSettings({
      embeddingMode: "cloud",
      embeddingCloud: { baseUrl: "https://api.siliconflow.cn/v1", apiKey: "  sk-sf  " },
    });
    expect(s.embeddingCloud?.apiKey).toBe("sk-sf");
  });
});

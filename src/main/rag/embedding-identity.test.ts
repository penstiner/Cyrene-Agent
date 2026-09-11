// getEmbeddingProviderIdentity 云端模式回归测试：
// 云端 provider 且维度未声明（留空自动探测）时，cacheIdentity 在首次 embed 前是 undefined。
// 修复前本函数直接抛错 → 贴纸/场景/文档索引缓存键构建死锁（建索引本身就是第一次 embed），
// 表现：云端模式下表情包/场景匹配全失效，切回本地模型恢复。
// 修复后：自动做一次预热 embed 探测维度，再返回完整 identity。
import { describe, expect, it, vi } from "vitest";

import { getEmbeddingProviderIdentity, type EmbeddingProvider } from "./embedding";

/** 云端 mock：resolvedDimensions 起始为 undefined，首次 embed 后解析为 vector.length。 */
function makeCloudProvider(opts: { declared?: number } = {}): EmbeddingProvider & { embedCalls: string[] } {
  const embedCalls: string[] = [];
  let resolvedDims: number | undefined = opts.declared;
  let dims = opts.declared;
  return {
    embedCalls,
    name: "openai-compat-BAAI/bge-m3",
    get dims() {
      if (resolvedDims === undefined) throw new Error("Embedding dimensions not yet resolved");
      return resolvedDims;
    },
    get declaredDimensions() {
      return opts.declared;
    },
    get resolvedDimensions() {
      return resolvedDims;
    },
    get cacheIdentity() {
      if (resolvedDims === undefined) return undefined;
      return {
        provider: "openai-compat",
        model: "BAAI/bge-m3",
        dimensions: resolvedDims,
        endpoint: "https://api.siliconflow.cn/v1",
      };
    },
    workerConfig: undefined,
    async embed(text: string) {
      embedCalls.push(text);
      dims = dims ?? 1024;
      resolvedDims = dims;
      return new Array(dims).fill(0.1);
    },
    async embedBatch(texts: string[]) {
      return texts.map(() => new Array(dims ?? 1024).fill(0.1));
    },
  } as unknown as EmbeddingProvider & { embedCalls: string[] };
}

describe("getEmbeddingProviderIdentity 云端维度自动探测", () => {
  it("维度未声明：预热 embed 一次后返回完整 identity", async () => {
    const provider = makeCloudProvider();
    expect(provider.cacheIdentity).toBeUndefined();

    const identity = await getEmbeddingProviderIdentity(provider);

    expect(provider.embedCalls).toEqual(["cyrene-identity-warmup"]);
    expect(identity.provider).toBe("openai-compat");
    expect(identity.model).toBe("BAAI/bge-m3");
    expect(identity.dimensions).toBe(1024);
    expect(identity.endpoint).toBe("https://api.siliconflow.cn/v1");
  });

  it("已声明维度：cacheIdentity 直接可用，不发预热请求", async () => {
    const provider = makeCloudProvider({ declared: 1024 });
    expect(provider.cacheIdentity).toBeDefined();

    const identity = await getEmbeddingProviderIdentity(provider);

    expect(provider.embedCalls).toEqual([]);
    expect(identity.dimensions).toBe(1024);
  });

  it("provider 缺失：抛错", async () => {
    await expect(getEmbeddingProviderIdentity(null)).rejects.toThrow("Embedding provider is not available");
  });

  it("维度解析后再次调用：直接命中 cacheIdentity，不重复预热", async () => {
    const provider = makeCloudProvider();
    await getEmbeddingProviderIdentity(provider);
    const second = await getEmbeddingProviderIdentity(provider);
    expect(provider.embedCalls).toEqual(["cyrene-identity-warmup"]);
    expect(second.dimensions).toBe(1024);
  });
});

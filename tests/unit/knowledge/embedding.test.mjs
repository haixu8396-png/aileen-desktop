// ============================================================
// embedding：离线降级、后端失败降级、远端成功的形状
// 全部用注入的假 fetch，测试里**不打网络**
// ============================================================

import { describe, it, expect } from 'vitest';
import { createKnowledgeEmbedder, isUsableVector, offlineConfig } from '../../../src/knowledge/embeddings.js';
import { makeEngine, fakeFetch } from './helpers.mjs';

/** 造一个正常的 OpenAI 兼容 embedding 响应 */
function okResponse(dim = 8) {
  return {
    ok: true,
    status: 200,
    json: {
      data: [
        { index: 0, embedding: Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0)) },
        { index: 1, embedding: Array.from({ length: dim }, (_, i) => (i === 1 ? 1 : 0)) },
      ],
    },
  };
}

describe('embedding / 离线降级', () => {
  it('enabled:false → 本地向量，且说明原因是 disabled', async () => {
    const embedder = createKnowledgeEmbedder({ getConfig: () => ({ enabled: false }) });
    const vecs = await embedder.embed(['知识库', '检索']);
    expect(vecs.length).toBe(2);
    expect(vecs[0]).toHaveLength(512); // shared/embeddings.cjs 的本地哈希空间
    expect(embedder.mode()).toBe('local');
    expect(embedder.stats().local).toBe(2);
    expect(embedder.stats().lastFallbackReason).toBe('disabled');
  });

  it('没给 getConfig 时默认离线（知识库绝不自己去猜远端地址）', async () => {
    const embedder = createKnowledgeEmbedder({});
    await embedder.embedOne('测试');
    expect(embedder.mode()).toBe('local');
    expect(embedder.stats().lastFallbackReason).toBe('disabled');
    expect(embedder.stats().remote).toBe(0);
  });

  it('给了 getConfig 但没配地址 → no-config', async () => {
    const embedder = createKnowledgeEmbedder({ getConfig: () => ({ enabled: true }) });
    await embedder.embedOne('测试');
    expect(embedder.mode()).toBe('local');
    expect(embedder.stats().lastFallbackReason).toBe('no-config');
  });

  it('offlineConfig 是显式的离线配置', () => {
    expect(offlineConfig()).toEqual({ enabled: false });
  });

  it('同样的文本得到同样的向量（离线也是确定的）', async () => {
    const embedder = createKnowledgeEmbedder({ getConfig: offlineConfig });
    const a = await embedder.embedOne('确定性');
    const b = await embedder.embedOne('确定性');
    expect(a).toEqual(b);
  });
});

describe('embedding / 后端失败一律降级，不抛错', () => {
  const remoteConfig = () => ({ enabled: true, baseUrl: 'https://example.invalid/v1', apiKey: 'test-key', model: 'text-embedding-3-small' });

  it('HTTP 500 → 本地向量 + errors 计数', async () => {
    const embedder = createKnowledgeEmbedder({ getConfig: remoteConfig, fetchImpl: fakeFetch([{ ok: false, status: 500 }]) });
    const vecs = await embedder.embed(['知识库']);
    expect(vecs[0]).toHaveLength(512);
    expect(embedder.mode()).toBe('local');
    expect(embedder.stats().errors).toBe(1);
    expect(embedder.stats().lastFallbackReason).toBe('http-500');
  });

  it('fetch 直接抛（网络不通）→ 本地向量', async () => {
    const embedder = createKnowledgeEmbedder({ getConfig: remoteConfig, fetchImpl: fakeFetch([{ throw: 'ECONNREFUSED' }]) });
    await expect(embedder.embed(['知识库'])).resolves.toBeDefined();
    expect(embedder.mode()).toBe('local');
    expect(embedder.stats().lastFallbackReason).toContain('ECONNREFUSED');
  });

  it('返回条数对不上 → 降级，不把错位的向量存进去', async () => {
    const fetchImpl = fakeFetch([{ ok: true, status: 200, json: { data: [{ index: 0, embedding: [1, 0, 0] }] } }]);
    const embedder = createKnowledgeEmbedder({ getConfig: remoteConfig, fetchImpl });
    const vecs = await embedder.embed(['a', 'b', 'c']);
    expect(vecs).toHaveLength(3);
    expect(embedder.stats().lastFallbackReason).toBe('count-mismatch');
  });

  it('后端正常 → 用后端向量，mode 变 remote', async () => {
    const embedder = createKnowledgeEmbedder({ getConfig: remoteConfig, fetchImpl: fakeFetch([okResponse(8)]) });
    const vecs = await embedder.embed(['a', 'b']);
    expect(vecs[0]).toHaveLength(8);
    expect(embedder.mode()).toBe('remote');
    expect(embedder.stats().remote).toBe(2);
  });
});

describe('embedding / 与 engine 的配合', () => {
  it('后端坏掉时仍能建索引与检索（降级而不是崩）', async () => {
    const { kb } = makeEngine({
      getConfig: () => ({ enabled: true, baseUrl: 'https://example.invalid/v1', apiKey: 'test-key' }),
      fetchImpl: fakeFetch([{ ok: false, status: 503 }]),
    });
    const added = await kb.addText({ text: '知识库的检索流程：召回之后必须再做一次精排。', name: '流程.md' });
    expect(added.chunk_count).toBeGreaterThan(0);
    expect(added.vectorized_chunks).toBe(added.chunk_count); // 降级到本地向量，仍然是"有向量"
    const results = await kb.search('精排');
    expect(results.length).toBeGreaterThan(0);
    const status = await kb.indexStatus();
    expect(status.embedding.mode).toBe('local');
    expect(status.embedding.stats.errors).toBeGreaterThan(0);
    expect(status.embedding.stats.lastFallbackReason).toBe('http-503');
    expect(status.vectorized).toBe(true);
  });

  it('isUsableVector 拒绝维度不一致的向量（避免拿噪声算余弦）', () => {
    expect(isUsableVector([1, 2, 3], 3)).toBe(true);
    expect(isUsableVector([1, 2, 3], 4)).toBe(false);
    expect(isUsableVector(null, 3)).toBe(false);
    expect(isUsableVector([], 3)).toBe(false);
  });
});

// ============================================================
// 共享嵌入底座（shared/embeddings.cjs）的宿主代发路径
//
// 这一条是补一个**真机上才会暴露**的坑：渲染层拿到的设置里 apiKey 永远是空的
// （密钥只存在主进程），于是 createEmbedder 里那句 `!cfg.apiKey → 走本地`
// 会让渲染层**永远**用不上远端嵌入 —— 症状极其隐蔽：设置页一切正常、
// 检索也「能用」，只是静默退化成关键词级别的本地词频向量。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createEmbedder, localEmbed, LOCAL_DIM } = require('../../shared/embeddings.cjs');

/** 渲染层那侧的形状：只有地址与模型，**没有 apiKey** */
const rendererConfig = () => ({
  enabled: true,
  baseUrl: 'https://api.openai.com/v1',
  model: 'text-embedding-3-small',
});

describe('createEmbedder：宿主代发（embedFn）', () => {
  it('没有 apiKey 也必须走宿主，而不是静默本地降级', async () => {
    const calls = [];
    const embed = createEmbedder({
      getConfig: rendererConfig,
      embedFn: async (texts, cfg) => {
        calls.push({ texts, cfg });
        return texts.map(() => new Array(LOCAL_DIM).fill(0.5));
      },
    });

    const vecs = await embed.embed(['你好']);
    expect(calls).toHaveLength(1);
    expect(calls[0].texts).toEqual(['你好']);
    expect(calls[0].cfg.baseUrl).toBe('https://api.openai.com/v1');
    expect(vecs).toHaveLength(1);
    expect(embed.mode()).toBe('remote');
    expect(embed.stats().remote).toBe(1);
    expect(embed.stats().local).toBe(0);
  });

  it('没配地址时仍然本地降级（离线可用是硬要求）', async () => {
    let called = 0;
    const embed = createEmbedder({
      getConfig: () => ({ enabled: true, baseUrl: '', model: 'x' }),
      embedFn: async () => { called += 1; return []; },
    });
    const vecs = await embed.embed(['你好']);
    expect(called).toBe(0);
    expect(vecs[0]).toEqual(Array.from(localEmbed('你好')));
    expect(embed.mode()).toBe('local');
    expect(embed.stats().lastFallbackReason).toBe('no-config');
  });

  it('显式关掉时本地（enabled:false）', async () => {
    let called = 0;
    const embed = createEmbedder({
      getConfig: () => ({ enabled: false, baseUrl: 'https://a/v1', model: 'x' }),
      embedFn: async () => { called += 1; return []; },
    });
    await embed.embed(['x']);
    expect(called).toBe(0);
    expect(embed.stats().lastFallbackReason).toBe('disabled');
  });

  it('宿主抛错时降级本地，并把原因写进 stats', async () => {
    const embed = createEmbedder({
      getConfig: rendererConfig,
      embedFn: async () => { throw new Error('502 bad gateway'); },
    });
    const vecs = await embed.embed(['x']);
    expect(vecs).toHaveLength(1);
    expect(embed.mode()).toBe('local');
    expect(embed.stats().errors).toBe(1);
    expect(embed.stats().lastFallbackReason).toContain('502');
  });

  it('宿主返回条数对不上时按失败处理', async () => {
    const embed = createEmbedder({
      getConfig: rendererConfig,
      embedFn: async () => [[]],   // 要两条只给一条
    });
    await embed.embed(['a', 'b']);
    expect(embed.stats().lastFallbackReason).toBe('count-mismatch');
  });

  it('主进程那侧（自带 fetchImpl + apiKey）不受影响', async () => {
    const seen = [];
    const embed = createEmbedder({
      getConfig: () => ({ enabled: true, baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x', model: 'm' }),
      fetchImpl: async (url, init) => {
        seen.push({ url, body: JSON.parse(init.body) });
        return {
          ok: true,
          json: async () => ({ data: [{ index: 0, embedding: new Array(LOCAL_DIM).fill(0.25) }] }),
        };
      },
    });
    const vecs = await embed.embed(['hi']);
    expect(seen[0].url).toBe('https://api.openai.com/v1/embeddings');
    expect(vecs).toHaveLength(1);
    expect(embed.mode()).toBe('remote');
  });

  it('主进程那侧缺 apiKey 时不下手（不发请求）', async () => {
    let fetched = 0;
    const embed = createEmbedder({
      getConfig: () => ({ enabled: true, baseUrl: 'https://api.openai.com/v1', model: 'm' }),
      fetchImpl: async () => { fetched += 1; return { ok: true, json: async () => ({ data: [] }) }; },
    });
    await embed.embed(['hi']);
    expect(fetched).toBe(0);
    expect(embed.stats().lastFallbackReason).toBe('no-config');
  });
});

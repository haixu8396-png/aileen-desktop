// ============================================================
// retrieval：召回（第一趟）—— 相关能召回、无关不召回、k / budgetTokens、
// 元数据过滤、Query Rewrite 规则、离线降级
// ============================================================

import { describe, it, expect } from 'vitest';
import { makeEngine, createMemoryFs } from './helpers.mjs';
import {
  rewriteQuery, matchesFilters, retrieve, buildContext, formatCitations, DEFAULT_MIN_SCORE,
} from '../../../src/knowledge/retriever.js';

const CHUNKING_DOC = '知识库的切块策略：优先在段落边界切，其次是句子，最后才是硬切。默认每块不超过 400 token，相邻块之间保留重叠，避免答案正好横跨切口。';
const COFFEE_DOC = '咖啡机使用说明：先加清水到刻度线，再放入咖啡豆，按下开始键，等待三分钟即可饮用。清洁时请先断开电源。';

async function seed() {
  const seeded = makeEngine();
  const a = await seeded.kb.addText({ text: CHUNKING_DOC, name: '切块说明.md' });
  const b = await seeded.kb.addText({ text: COFFEE_DOC, name: '咖啡机.md' });
  return Object.assign(seeded, { a, b });
}

describe('retrieval / Query Rewrite（规则式）', () => {
  it('剥掉疑问词与尾部语气词，留下关键词', () => {
    const r = rewriteQuery('请问如何配置知识库的切块大小？');
    expect(r.removed).toContain('请问');
    expect(r.removed).toContain('如何');
    expect(r.rewritten).toBe('配置知识库的切块大小');
    expect(r.keywords.length).toBeGreaterThan(3);
  });

  it('英文疑问句同样处理', () => {
    const r = rewriteQuery('What is the chunk size?');
    expect(r.rewritten.toLowerCase()).toBe('the chunk size');
  });

  it('剥光了就退回原句（不交白卷）', () => {
    const r = rewriteQuery('为什么？');
    expect(r.rewritten).toBe('为什么？');
  });

  it('没有疑问词的查询保持原样', () => {
    const r = rewriteQuery('切块重叠');
    expect(r.rewritten).toBe('切块重叠');
    expect(r.removed).toEqual([]);
  });
});

describe('retrieval / 元数据过滤', () => {
  const chunk = {
    document_id: 'doc_1',
    content: 'x',
    page: 2,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-03-01T00:00:00.000Z',
    source: { kind: 'file', filename: '手册.pdf', path: 'D:/docs/手册.pdf', extension: 'pdf', format: 'pdf' },
    metadata: { token_count: 10, format: 'pdf', tags: ['手册'] },
  };

  it('按文档 id / 文件名 / 扩展名 / source / 路径', () => {
    expect(matchesFilters(chunk, { documentIds: ['doc_1'] })).toBe(true);
    expect(matchesFilters(chunk, { documentIds: ['doc_2'] })).toBe(false);
    expect(matchesFilters(chunk, { filename: '手册' })).toBe(true);
    expect(matchesFilters(chunk, { filename: '别的' })).toBe(false);
    expect(matchesFilters(chunk, { extensions: ['pdf'] })).toBe(true);
    expect(matchesFilters(chunk, { extensions: ['.pdf'] })).toBe(true);
    expect(matchesFilters(chunk, { extensions: ['md'] })).toBe(false);
    expect(matchesFilters(chunk, { source: 'file' })).toBe(true);
    expect(matchesFilters(chunk, { source: 'text' })).toBe(false);
    expect(matchesFilters(chunk, { source: '手册' })).toBe(true);
    expect(matchesFilters(chunk, { path: 'D:/docs' })).toBe(true);
    expect(matchesFilters(chunk, { path: 'E:/other' })).toBe(false);
    expect(matchesFilters(chunk, { tags: ['手册'] })).toBe(true);
    expect(matchesFilters(chunk, { tags: ['别的'] })).toBe(false);
    expect(matchesFilters(chunk, { page: 2 })).toBe(true);
    expect(matchesFilters(chunk, { page: 1 })).toBe(false);
  });

  it('按时间区间（含字符串日期与 Date 对象）', () => {
    expect(matchesFilters(chunk, { since: '2024-02-01' })).toBe(true);
    expect(matchesFilters(chunk, { since: '2024-04-01' })).toBe(false);
    expect(matchesFilters(chunk, { until: '2024-04-01' })).toBe(true);
    expect(matchesFilters(chunk, { until: '2024-01-01' })).toBe(false);
    expect(matchesFilters(chunk, { since: new Date('2024-02-01T00:00:00Z'), until: new Date('2024-04-01T00:00:00Z') })).toBe(true);
    // timeField 可以切到 created_at
    expect(matchesFilters(chunk, { timeField: 'created_at', since: '2024-02-01' })).toBe(false);
  });

  it('支持自定义 filter 函数', () => {
    expect(matchesFilters(chunk, { filter: (c) => c.page === 2 })).toBe(true);
    expect(matchesFilters(chunk, { filter: () => false })).toBe(false);
  });
});

describe('retrieval / 召回行为', () => {
  it('相关文档能召回，且排在无关文档前面', async () => {
    const { kb } = await seed();
    const results = await kb.search('切块策略是什么？');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filename).toBe('切块说明.md');
    expect(results[0].content).toContain('切块策略');
  });

  it('无关查询不召回（低于 minScore 直接丢掉）', async () => {
    const { kb } = await seed();
    const results = await kb.search('如何修理汽车发动机的涡轮增压器');
    expect(results).toEqual([]);
  });

  it('k 生效', async () => {
    const { kb } = makeEngine();
    for (const name of ['一', '二', '三', '四']) {
      await kb.addText({ text: '知识库检索说明第' + name + '篇：' + name.repeat(20), name: 'doc' + name + '.md' });
    }
    const all = await kb.search('知识库检索说明', { k: 10 });
    expect(all.length).toBeGreaterThan(2);
    const two = await kb.search('知识库检索说明', { k: 2 });
    expect(two).toHaveLength(2);
    expect(two[0].chunk_id).toBe(all[0].chunk_id);
  });

  it('budgetTokens 生效：结果 token 总量不超过预算', async () => {
    const { kb } = makeEngine();
    await kb.addText({ text: '切块与重叠的说明。'.repeat(60), name: '长文.md' });
    const withoutBudget = await kb.search('切块重叠', { k: 5 });
    expect(withoutBudget.length).toBeGreaterThan(1);
    const budget = withoutBudget[0].token_count + 10;
    const limited = await kb.search('切块重叠', { k: 5, budgetTokens: budget });
    expect(limited.length).toBeLessThan(withoutBudget.length);
    const used = limited.reduce((n, r) => n + r.token_count, 0);
    expect(used).toBeLessThanOrEqual(budget);
  });

  it('元数据过滤在搜到结果之后依然生效（按文档 / 扩展名）', async () => {
    const { kb, a, b } = await seed();
    const unfiltered = await kb.search('段落边界的重叠', { k: 5 });
    expect(unfiltered.length).toBeGreaterThan(0);
    expect(unfiltered[0].document_id).toBe(a.id);

    const onlyA = await kb.search('段落边界的重叠', { filters: { documentIds: [a.id] } });
    expect(onlyA.length).toBeGreaterThan(0);
    expect(onlyA.every((r) => r.document_id === a.id)).toBe(true);

    // 把过滤条件换成另一篇文档：原来排第一的那条必须消失（被挡在召回之外）
    const onlyB = await kb.search('段落边界的重叠', { filters: { documentIds: [b.id] } });
    expect(onlyB.every((r) => r.document_id === b.id)).toBe(true);
    expect(onlyB.some((r) => r.chunk_id === unfiltered[0].chunk_id)).toBe(false);

    const onlyMd = await kb.search('说明', { filters: { extensions: ['md'] } });
    expect(onlyMd.every((r) => r.extension === 'md')).toBe(true);
  });

  it('按 source 类型过滤：文件来源与文本来源分开', async () => {
    const { kb, fs } = await seed();
    fs.set('/docs/切块.txt', '切块说明（文件来源）：段落优先，其次句子。');
    const fileDoc = await kb.addDocument('/docs/切块.txt');
    const fromFile = await kb.search('切块说明', { filters: { source: 'file' } });
    expect(fromFile.length).toBeGreaterThan(0);
    expect(fromFile.every((r) => r.source.kind === 'file')).toBe(true);
    expect(fromFile.some((r) => r.document_id === fileDoc.id)).toBe(true);

    const fromText = await kb.search('切块说明', { filters: { source: 'text' } });
    expect(fromText.every((r) => r.source.kind === 'text')).toBe(true);
  });

  it('按时间过滤：只召回更新后的文档', async () => {
    const { kb, clock } = makeEngine();
    await kb.addText({ text: '第一季度知识库说明：切块与重叠。', name: '旧.md' });
    clock.advanceDays(10);
    const fresh = await kb.addText({ text: '第二季度知识库说明：切块与重叠。', name: '新.md' });
    const results = await kb.search('知识库说明切块重叠', { filters: { since: '2024-01-05T00:00:00.000Z' } });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.document_id === fresh.id)).toBe(true);
  });
});

describe('retrieval / 离线与无向量兜底', () => {
  it('离线（enabled:false）下仍然可用，且说明当前是本地模式', async () => {
    const { kb } = await seed();
    const status = await kb.indexStatus();
    expect(status.embedding.mode).toBe('local');
    expect(status.embedding.stats.remote).toBe(0);
    const results = await kb.search('咖啡机怎么用');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filename).toBe('咖啡机.md');
  });

  it('chunk 完全没有向量时，retrieve 退回关键词通道', async () => {
    const chunks = [
      { id: 'c1', document_id: 'd1', content: '知识库检索需要召回与精排两步', title: null, embedding: null, metadata: { token_count: 20 }, source: { filename: 'a.md', extension: 'md' }, chunk_index: 0 },
      { id: 'c2', document_id: 'd2', content: '完全无关的另一段文字', title: null, embedding: null, metadata: { token_count: 20 }, source: { filename: 'b.md', extension: 'md' }, chunk_index: 0 },
    ];
    const out = retrieve({ query: '召回与精排', chunks, queryVector: null, k: 5, mode: 'local' });
    expect(out.candidates.length).toBe(1);
    expect(out.candidates[0].chunk.id).toBe('c1');
    expect(out.candidates[0].dense).toBe(0);
    expect(out.candidates[0].keyword).toBeGreaterThan(0);
  });

  it('dim 不一致的旧向量被忽略（不会拿噪声算余弦）', async () => {
    const chunks = [
      { id: 'c1', document_id: 'd1', content: '召回与精排', title: null, embedding: [1, 0, 0], metadata: { token_count: 10 }, source: { filename: 'a.md' }, chunk_index: 0 },
    ];
    const out = retrieve({ query: '召回', chunks, queryVector: [1, 0, 0, 0, 0], k: 5, mode: 'remote' });
    expect(out.candidates[0].dense).toBe(0);
  });

  it('默认 minScore 是公开常量（方便上层解释"为什么这条没召回"）', () => {
    expect(DEFAULT_MIN_SCORE).toBeGreaterThan(0);
    expect(DEFAULT_MIN_SCORE).toBeLessThan(0.5);
  });
});

describe('retrieval / Context Builder 与引用', () => {
  it('buildContext 带引用头，并遵守 token 预算', async () => {
    const { kb } = await seed();
    const results = await kb.search('切块策略', { k: 3 });
    const full = buildContext(results);
    expect(full.text).toContain('[1] 《切块说明.md》');
    expect(full.items).toBe(results.length);
    const limited = buildContext(results, { budgetTokens: 5 });
    expect(limited.items).toBeLessThan(results.length);
  });

  it('formatCitations 每条一行，带序号与 chunk id', async () => {
    const { kb } = await seed();
    const results = await kb.search('切块策略', { k: 2 });
    const text = formatCitations(results);
    expect(text.split('\n').length).toBe(results.length);
    for (const r of results) {
      expect(text).toContain(r.chunk_id);
      expect(text).toContain(r.filename);
    }
  });

  it('空结果不会炸', () => {
    expect(buildContext([]).text).toBe('');
    expect(formatCitations([])).toBe('');
  });
});

describe('retrieval / 内存 fs 直连 store（确保单测不碰磁盘）', () => {
  it('createMemoryFs 可以独立使用', async () => {
    const fs = createMemoryFs({ '/kb/x.txt': '内容' });
    expect(await fs.readText('/kb/x.txt')).toBe('内容');
    expect(await fs.exists('/kb/x.txt')).toBe(true);
    expect(await fs.exists('/kb/none.txt')).toBe(false);
  });
});

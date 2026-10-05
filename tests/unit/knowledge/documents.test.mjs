// ============================================================
// 文档生命周期：新增 / 更新 / 重新索引 / 删除 / 存储损坏
//
// 最关键的回归断言（这两个 bug 一旦出现，用户是"搜到旧内容"级别的伤害）：
//   · update 之后**旧 chunk 不能残留**
//   · delete 之后**其它文档的 chunk 一个不少**
// ============================================================

import { describe, it, expect } from 'vitest';
import { makeEngine, createMemoryFs } from './helpers.mjs';
import { createStore } from '../../../src/knowledge/store.js';

async function chunkIdsOf(kb, docId) {
  const chunks = await kb.store.readChunks(docId);
  return chunks.map((c) => c.id).sort();
}

describe('文档 / 新增', () => {
  it('addText 建索引：chunk 数、向量化状态、时间戳都对', async () => {
    const { kb, clock } = makeEngine();
    const added = await kb.addText({ text: '知识库新增文档的说明。'.repeat(20), name: '新增.md' });
    expect(added.chunk_count).toBeGreaterThan(0);
    expect(added.replaced).toBe(false);
    expect(added.mode).toBe('local');
    const doc = kb.getDocument(added.id);
    expect(doc.status).toBe('indexed');
    expect(doc.vectorized).toBe(true);
    expect(doc.created_at).toBe(clock.now());
    expect(doc.updated_at).toBe(clock.now());
    expect(kb.listDocuments()).toHaveLength(1);
  });

  it('addDocument 从注入的 fs 读文件（txt 走完整流水线）', async () => {
    const { kb, fs } = makeEngine();
    fs.set('/docs/note.txt', '第一行标题\n\n知识库正文内容：段落优先切块。');
    const added = await kb.addDocument('/docs/note.txt');
    const doc = kb.getDocument(added.id);
    expect(doc.kind).toBe('file');
    expect(doc.format).toBe('txt');
    expect(doc.title).toBe('第一行标题');
    expect(doc.path).toBe('/docs/note.txt');
    expect((await kb.search('段落优先切块')).length).toBeGreaterThan(0);
  });

  it('读不到文件时抛的是能看懂的错（而不是静默空文档）', async () => {
    const { kb } = makeEngine();
    await expect(kb.addDocument('/docs/missing.txt')).rejects.toThrow(/读不到知识库文件/);
  });

  it('不支持的格式直接拒绝', async () => {
    const { kb } = makeEngine();
    await expect(kb.addDocument('/docs/a.docx')).rejects.toThrow(/不支持的知识库格式/);
  });

  it('同一路径再导入 = 更新同一篇（不会多出一篇孤儿文档）', async () => {
    const { kb, fs, clock } = makeEngine();
    fs.set('/docs/same.txt', '第一版内容。');
    const first = await kb.addDocument('/docs/same.txt');
    clock.advanceDays(1);
    fs.set('/docs/same.txt', '第二版内容，已经不一样了。');
    const second = await kb.addDocument('/docs/same.txt');
    expect(second.id).toBe(first.id);
    expect(second.replaced).toBe(true);
    expect(second.changed).toBe(true);
    expect(kb.listDocuments()).toHaveLength(1);
  });
});

describe('文档 / 更新（update）', () => {
  it('改了内容后：旧 chunk 不残留、新内容搜得到、updated_at 变了', async () => {
    const { kb, fs, clock } = makeEngine();
    const added = await kb.addText({ text: '第一版内容讲的是知识库切块边界与重叠策略。', name: 'a.md' });
    const before = kb.getDocument(added.id);
    const oldIds = await chunkIdsOf(kb, added.id);

    clock.advanceDays(1);
    const updated = await kb.updateDocument(added.id, {
      kind: 'text',
      text: '第二版内容讲的是向量检索召回与精排权重。',
      name: 'a.md',
    });

    expect(updated.id).toBe(added.id);
    expect(updated.updated).toBe(true);
    const after = kb.getDocument(added.id);
    expect(after.updated_at).not.toBe(before.updated_at);
    expect(after.created_at).toBe(before.created_at); // 创建时间不能跟着变
    expect(after.content_hash).not.toBe(before.content_hash);

    // 旧 chunk 不残留：chunk 文件里不能出现第一版的字样
    const rawFile = fs.dump()['/kb/chunks/' + encodeURIComponent(added.id) + '.json'];
    expect(rawFile).not.toContain('第一版');
    expect(rawFile).toContain('第二版');

    // chunk id 是按位置派生的（doc_x#0000…），所以更新后 id 可能一样，
    // 但**内容**必须是新的：这才是"旧 chunk 不残留"的真正含义
    const newIds = await chunkIdsOf(kb, added.id);
    expect(newIds.length).toBeGreaterThan(0);
    const newContents = (await kb.store.readChunks(added.id)).map((c) => c.content).join('');
    expect(newContents).toContain('第二版');
    expect(newContents).not.toContain('第一版');

    // 新内容搜得到；旧内容再也命中不了（拿第一版独有的词去查，没有任何块带它）
    const fresh = await kb.search('向量检索召回与精排', { filters: { documentIds: [added.id] } });
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((r) => r.content.includes('第二版'))).toBe(true);
    const stale = await kb.search('第一版切块边界与重叠策略', { filters: { documentIds: [added.id] } });
    expect(stale.some((r) => r.content.includes('第一版'))).toBe(false);

    // 而且全局 chunk 计数与文档声明一致，没有幽灵 chunk
    const status = await kb.indexStatus();
    expect(status.chunks).toBe(after.chunk_count);
  });

  it('内容没变时 changed=false（上层可以据此不重建，但仍然完成替换）', async () => {
    const { kb } = makeEngine();
    const added = await kb.addText({ text: '内容保持不变的文档。', name: 'same.md' });
    const again = await kb.updateDocument(added.id, { kind: 'text', text: '内容保持不变的文档。', name: 'same.md' });
    expect(again.changed).toBe(false);
    expect(again.chunk_count).toBeGreaterThan(0);
  });

  it('update 一个不存在的 id 会报错（不静默新建）', async () => {
    const { kb } = makeEngine();
    await expect(kb.updateDocument('doc_nope', { kind: 'text', text: 'x' })).rejects.toThrow(/没有这篇文档/);
  });

  it('更新时源身份跟着新来源走（路径/文件名会更新）', async () => {
    const { kb } = makeEngine();
    const added = await kb.addText({ text: '旧文件名。', name: 'old.md' });
    await kb.updateDocument(added.id, { kind: 'text', text: '新文件名与内容。', name: 'new.md' });
    expect(kb.getDocument(added.id).filename).toBe('new.md');
  });
});

describe('文档 / 重新索引（reindex）', () => {
  it('文本来源：从保存的文本重切，id 与 created_at 不变，并说明是"从存储重切"', async () => {
    const { kb, clock } = makeEngine();
    const added = await kb.addText({ text: '重新索引测试：切块与重叠。'.repeat(10), name: 'r.md' });
    const before = kb.getDocument(added.id);
    clock.advanceDays(2);
    const result = await kb.reindexDocument(added.id);
    expect(result.reindexed).toBe(true);
    expect(result.from_file).toBe(false);
    expect(result.warnings.some((w) => w.code === 'reindexed-from-store')).toBe(true);
    const after = kb.getDocument(added.id);
    expect(after.id).toBe(before.id);
    expect(after.created_at).toBe(before.created_at);
    expect(after.updated_at).not.toBe(before.updated_at);
    expect(after.chunk_count).toBe(before.chunk_count);
  });

  it('文件来源：真的重新读盘（磁盘内容变了，索引跟着变）', async () => {
    const { kb, fs } = makeEngine();
    fs.set('/docs/live.txt', '第一版：切块策略。');
    const added = await kb.addDocument('/docs/live.txt');
    fs.set('/docs/live.txt', '第二版：向量检索与精排。');
    const result = await kb.reindexDocument(added.id);
    expect(result.from_file).toBe(true);
    // 身份没被改掉：还是一个 file 文档
    const doc = kb.getDocument(added.id);
    expect(doc.kind).toBe('file');
    expect(doc.path).toBe('/docs/live.txt');
    const fresh = await kb.search('向量检索与精排', { filters: { documentIds: [added.id] } });
    expect(fresh.length).toBeGreaterThan(0);
    const stale = await kb.search('切块策略', { filters: { documentIds: [added.id] } });
    expect(stale).toEqual([]);
  });

  it('文件读不到时退回存储文本，并给出 warning（不假装重新解析过）', async () => {
    const { kb, fs } = makeEngine();
    fs.set('/docs/gone.txt', '这份文件随后会被删掉。');
    const added = await kb.addDocument('/docs/gone.txt');
    await fs.remove('/docs/gone.txt');
    const result = await kb.reindexDocument(added.id);
    expect(result.from_file).toBe(false);
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain('reindex-file-read-failed');
    expect(codes).toContain('reindexed-from-store');
    expect(kb.getDocument(added.id).kind).toBe('file'); // 身份不被降级成 text
  });

  it('reindex 不存在的 id 会报错', async () => {
    const { kb } = makeEngine();
    await expect(kb.reindexDocument('doc_nope')).rejects.toThrow(/没有这篇文档/);
  });
});

describe('文档 / 删除（delete）', () => {
  it('删掉后搜不到，且**其它文档的 chunk 一个不少**', async () => {
    const { kb, fs } = makeEngine();
    const a = await kb.addText({ text: '文档A：知识库切块说明。'.repeat(6), name: 'a.md' });
    const b = await kb.addText({ text: '文档B：咖啡机使用与清洁说明。'.repeat(6), name: 'b.md' });
    const c = await kb.addText({ text: '文档C：知识库存储与原子写。'.repeat(6), name: 'c.md' });

    const aIdsBefore = await chunkIdsOf(kb, a.id);
    const cIdsBefore = await chunkIdsOf(kb, c.id);
    const totalBefore = (await kb.indexStatus()).chunks;
    const bCount = kb.getDocument(b.id).chunk_count;

    const removed = await kb.removeDocument(b.id);
    expect(removed.removed).toBe(true);
    expect(removed.removed_chunks).toBe(bCount);

    // B 彻底没了
    expect(kb.getDocument(b.id)).toBeNull();
    expect(await kb.store.readChunks(b.id)).toEqual([]);
    expect(await fs.exists('/kb/chunks/' + encodeURIComponent(b.id) + '.json')).toBe(false);
    expect(await kb.search('咖啡机清洁', { filters: { documentIds: [b.id] } })).toEqual([]);

    // 其它文档一个 chunk 都不能少（逐 id 比对，不只是看数量）
    expect(await chunkIdsOf(kb, a.id)).toEqual(aIdsBefore);
    expect(await chunkIdsOf(kb, c.id)).toEqual(cIdsBefore);
    const totalAfter = (await kb.indexStatus()).chunks;
    expect(totalAfter).toBe(totalBefore - bCount);
    expect(kb.listDocuments().map((d) => d.id).sort()).toEqual([a.id, c.id].sort());
  });

  it('删不存在的文档返回 removed:false，不抛错', async () => {
    const { kb } = makeEngine();
    expect(await kb.removeDocument('doc_nope')).toEqual({ id: 'doc_nope', removed: false, removed_chunks: 0 });
  });

  it('删掉再导入同一个文件，是干净的新文档', async () => {
    const { kb, fs } = makeEngine();
    fs.set('/docs/re.txt', '会被删掉再导入的内容。');
    const first = await kb.addDocument('/docs/re.txt');
    await kb.removeDocument(first.id);
    const second = await kb.addDocument('/docs/re.txt');
    expect(second.id).toBe(first.id);
    expect(second.replaced).toBe(false);
    expect(second.chunk_count).toBeGreaterThan(0);
  });
});

describe('文档 / 存储层（注入 fs）', () => {
  it('documents.json 损坏 → 空库 + errors，不抛错', async () => {
    const fs = createMemoryFs();
    const store = createStore({ fs, dir: '/kb' });
    await store.init();
    await store.saveContent('doc_1', { chunks: [{ id: 'doc_1#0000', content: 'x' }] });
    await store.upsertDocument({ id: 'doc_1', name: 'a' });
    fs.set('/kb/documents.json', '{ 这不是合法 JSON');

    const broken = createStore({ fs, dir: '/kb' });
    const init = await broken.init();
    expect(init.documents).toBe(0);
    expect(broken.documents()).toEqual([]);
    expect(broken.errors().some((e) => e.code === 'corrupt-json')).toBe(true);
    expect(broken.errors()[0].message).toBeTruthy();
  });

  it('chunks 文件损坏 → 该文档 0 chunk + errors，其它文档不受影响', async () => {
    const fs = createMemoryFs();
    const store = createStore({ fs, dir: '/kb' });
    await store.init();
    await store.saveContent('doc_ok', { chunks: [{ id: 'doc_ok#0000', content: 'ok' }] });
    await store.saveContent('doc_bad', { chunks: [{ id: 'doc_bad#0000', content: 'bad' }] });
    await store.upsertDocument({ id: 'doc_ok', name: 'ok' });
    await store.upsertDocument({ id: 'doc_bad', name: 'bad' });
    fs.set('/kb/chunks/doc_bad.json', '坏了');

    const reopened = createStore({ fs, dir: '/kb' });
    await reopened.init();
    expect(await reopened.readChunks('doc_bad')).toEqual([]);
    expect((await reopened.readChunks('doc_ok')).length).toBe(1);
    expect(await reopened.iterChunks()).toHaveLength(1);
    expect(reopened.errors().some((e) => e.code === 'corrupt-json')).toBe(true);
  });

  it('写入是原子的：不留 .tmp，索引始终是合法 JSON', async () => {
    const { kb, fs } = makeEngine();
    await kb.addText({ text: '原子写测试。'.repeat(10), name: 'atomic.md' });
    const files = Object.keys(fs.dump());
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(() => JSON.parse(fs.dump()['/kb/documents.json'])).not.toThrow();
    const doc = kb.listDocuments()[0];
    expect(doc.chunk_count).toBeGreaterThan(0);
  });

  it('空库：search 返回空数组，indexStatus / listDocuments 不抛错', async () => {
    const { kb } = makeEngine();
    expect(await kb.search('任何查询')).toEqual([]);
    const status = await kb.indexStatus();
    expect(status.documents).toBe(0);
    expect(status.chunks).toBe(0);
    expect(status.vectorized).toBe(false);
    expect(status.errors).toEqual([]);
    expect(kb.listDocuments()).toEqual([]);
    expect(kb.getDocument('doc_nope')).toBeNull();
  });

  it('indexStatus 汇总文档/块/向量/错误/切块配置', async () => {
    const { kb } = makeEngine({ chunking: { maxTokens: 123, overlapTokens: 12 } });
    await kb.addText({ text: '索引状态测试文档。'.repeat(30), name: 's.md' });
    const status = await kb.indexStatus();
    expect(status.documents).toBe(1);
    expect(status.chunks).toBeGreaterThan(1);
    expect(status.vectorized_chunks).toBe(status.chunks);
    expect(status.vectorized).toBe(true);
    expect(status.embedding.mode).toBe('local');
    expect(status.embedding.dim).toBe(512);
    expect(status.chunking).toEqual({ max_tokens: 123, overlap_tokens: 12 });
    expect(Array.isArray(status.errors)).toBe(true);
  });
});

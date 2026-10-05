// ============================================================
// 来源追踪：LLM 用到知识库内容时，必须能回答"这句话来自哪个文档"
//   · 每条搜索结果都带 document_id / filename / chunk_id / page / source
//   · getSource(chunkId) 能把 chunk 追回文档
//   · formatCitations / buildContext 输出可读引用
// ============================================================

import { describe, it, expect } from 'vitest';
import { makeEngine, buildSimplePdf, PDF_CONTENT } from './helpers.mjs';
import { formatCitation, formatCitations } from '../../../src/knowledge/retriever.js';

const TRACKING_TEXT = '来源追踪说明：每个 chunk 都必须保留文档 id、文件名、页码与段落号，否则回答里没法标出处。';

async function seed() {
  const seeded = makeEngine();
  const md = await seeded.kb.addText({ text: TRACKING_TEXT, name: '追踪说明.md', metadata: { author: 'aileen' } });
  // 文件来源（txt）
  seeded.fs.set('/docs/handbook.txt', '手册文本：来源追踪也适用于文件来源的文档。');
  const txt = await seeded.kb.addDocument('/docs/handbook.txt');
  // PDF 来源（两页，用来验证页码）
  seeded.fs.set('/docs/manual.pdf', buildSimplePdf({
    pages: [
      'BT /F1 12 Tf 72 700 Td (Manual page one about source tracking) Tj ET',
      'BT /F1 12 Tf 72 700 Td (Manual page two about retrieval ranking) Tj ET',
    ],
  }));
  const pdf = await seeded.kb.addDocument('/docs/manual.pdf');
  return Object.assign(seeded, { md, txt, pdf });
}

describe('来源追踪 / 字段齐全', () => {
  it('每条搜索结果都能追回 document_id / filename / chunk_id', async () => {
    const { kb, md } = await seed();
    const results = await kb.search('来源追踪', { k: 5 });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.document_id).toBeTruthy();
      expect(r.chunk_id).toBeTruthy();
      expect(r.filename).toBeTruthy();
      expect(Number.isFinite(r.chunk_index)).toBe(true);
      expect(r.source).toBeTruthy();
      expect(r.source.filename).toBe(r.filename);
      expect(r.citation).toContain(r.chunk_id);
      // chunk_id 的命名规则里带有 document_id，肉眼就能对上
      expect(r.chunk_id.startsWith(r.document_id + '#')).toBe(true);
    }
    expect(results.some((r) => r.document_id === md.id)).toBe(true);
  });

  it('getSource(chunkId) 与搜索结果完全一致', async () => {
    const { kb } = await seed();
    const [first] = await kb.search('来源追踪', { k: 1 });
    const src = await kb.getSource(first.chunk_id);
    expect(src).toBeTruthy();
    expect(src.chunk_id).toBe(first.chunk_id);
    expect(src.document_id).toBe(first.document_id);
    expect(src.filename).toBe(first.filename);
    expect(src.source.path).toBe(first.source.path);
    expect(src.source.format).toBe(first.source.format);
    expect(src.chunk_index).toBe(first.chunk_index);
    expect(src.excerpt.length).toBeGreaterThan(0);
  });

  it('未知 chunk id 返回 null（不抛错）', async () => {
    const { kb } = await seed();
    expect(await kb.getSource('doc_nope#9999')).toBeNull();
  });

  it('PDF 结果带页码；没有页码概念的格式是 null', async () => {
    const { kb, pdf, md } = await seed();
    const pdfHit = await kb.search('retrieval ranking page two', { filters: { documentIds: [pdf.id] } });
    expect(pdfHit.length).toBeGreaterThan(0);
    expect(pdfHit[0].page).toBe(2);
    expect(pdfHit[0].source.format).toBe('pdf');
    expect(pdfHit[0].filename).toBe('manual.pdf');

    const mdHit = await kb.search('来源追踪', { filters: { documentIds: [md.id] } });
    expect(mdHit[0].page).toBeNull();
    expect(mdHit[0].citation).not.toContain('页码未知'); // 非 pdf 不写"页码未知"
  });

  it('文件来源的 path 能追回磁盘位置', async () => {
    const { kb, txt } = await seed();
    const results = await kb.search('手册文本 文件来源', { filters: { documentIds: [txt.id] } });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe('/docs/handbook.txt');
    expect(results[0].source.kind).toBe('file');
    expect(results[0].source.extension).toBe('txt');
  });
});

describe('来源追踪 / 引用串', () => {
  it('formatCitation 输出《文件名》· 章节 · 段落 · chunk id', async () => {
    const { kb, md } = await seed();
    const [first] = await kb.search('来源追踪', { k: 1, filters: { documentIds: [md.id] } });
    expect(first.filename).toBe('追踪说明.md');
    const line = formatCitation(first);
    expect(line).toContain('《追踪说明.md》');
    expect(line).toContain('chunk ' + first.chunk_id);
    expect(line).toMatch(/第 \d+ 段/);
    expect(line).toContain('小节「' + first.title + '」'); // 标题（无 # 标题时用文件名）也进引用
  });

  it('formatCitations 带序号、每条一行', async () => {
    const { kb } = await seed();
    const results = await kb.search('来源追踪', { k: 3 });
    const text = kb.formatCitations(results);
    const lines = text.split('\n');
    expect(lines).toHaveLength(results.length);
    lines.forEach((line, i) => {
      expect(line.startsWith('[' + (i + 1) + ']')).toBe(true);
    });
  });

  it('PDF 结果带页码引用', async () => {
    const { kb, pdf } = await seed();
    const results = await kb.search('Manual page two', { filters: { documentIds: [pdf.id] } });
    expect(kb.formatCitations(results)).toContain('第 2 页');
  });

  it('buildContext 把引用头拼在正文前面，并说明用量', async () => {
    const { kb } = await seed();
    const results = await kb.search('来源追踪', { k: 2 });
    const ctx = kb.buildContext(results);
    expect(ctx.items).toBe(results.length);
    expect(ctx.used_tokens).toBeGreaterThan(0);
    expect(ctx.text).toContain('[1] 《');
    expect(ctx.text).toContain(results[0].content.slice(0, 10));
  });
});

describe('来源追踪 / chunk 元数据里也留了痕迹', () => {
  it('chunk 自身带 source 与 page/json_path', async () => {
    const { kb, fs } = makeEngine();
    fs.set('/docs/data.json', JSON.stringify({ manual: { title: '手册', body: '知识库的键路径也要留痕。' } }));
    const added = await kb.addDocument('/docs/data.json');
    const chunks = await kb.store.readChunks(added.id);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].source.filename).toBe('data.json');
    expect(chunks[0].source.extension).toBe('json');
    expect(chunks[0].metadata.json_path).toContain('$.manual');
    const results = await kb.search('键路径留痕', { filters: { documentIds: [added.id] } });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk_id).toBe(chunks[0].id);
  });

  it('文档更新后，旧 chunk id 不会再出现在搜索结果里', async () => {
    const { kb, clock } = makeEngine();
    const added = await kb.addText({ text: '第一版来源追踪内容。'.repeat(20), name: 'v.md' });
    const beforeIds = new Set((await kb.store.readChunks(added.id)).map((c) => c.id));
    clock.advanceDays(1);
    await kb.updateDocument(added.id, { kind: 'text', text: '第二版来源追踪内容。'.repeat(5), name: 'v.md' });
    const afterIds = new Set((await kb.store.readChunks(added.id)).map((c) => c.id));
    const results = await kb.search('来源追踪内容', { k: 10, filters: { documentIds: [added.id] } });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(afterIds.has(r.chunk_id)).toBe(true);
    }
    // 少了一个块，旧的多出来的 id 必须消失
    if (beforeIds.size > afterIds.size) {
      const removed = [...beforeIds].filter((id) => !afterIds.has(id));
      expect(removed.length).toBeGreaterThan(0);
    }
  });

  it('formatCitations 对空结果返回空串（不抛）', () => {
    expect(formatCitations(null)).toBe('');
  });
});

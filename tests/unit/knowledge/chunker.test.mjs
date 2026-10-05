// ============================================================
// chunker：语义边界、重叠、上限、中文长文本、代码围栏
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  chunkPlainText, chunkDocument, splitIntoUnits, estimateTokens,
  DEFAULT_MAX_TOKENS, DEFAULT_OVERLAP_TOKENS,
} from '../../../src/knowledge/chunker.js';
import { parseMarkdown, parseTxt } from '../../../src/knowledge/parser.js';

/** 造一段中文长文本：每句 20 字左右，方便断言句子边界 */
function chineseParagraphs(count, perParagraph = 5) {
  const out = [];
  for (let p = 0; p < count; p += 1) {
    const sentences = [];
    for (let s = 0; s < perParagraph; s += 1) {
      sentences.push('第' + p + '段第' + s + '句讲的是知识库切块的语义边界问题。');
    }
    out.push(sentences.join(''));
  }
  return out.join('\n\n');
}

describe('chunker / token 估算', () => {
  it('中文按字、英文按词、标点折算', () => {
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('hello world')).toBe(2);
    expect(estimateTokens('')).toBe(0);
    // 标点/符号按 4 字符 1 token 折算
    expect(estimateTokens('!!!!')).toBe(1);
  });

  it('估算随长度单调不减', () => {
    const text = chineseParagraphs(3);
    let last = 0;
    for (let i = 1; i <= text.length; i += 50) {
      const t = estimateTokens(text.slice(0, i));
      expect(t).toBeGreaterThanOrEqual(last);
      last = t;
    }
  });
});

describe('chunker / 上限与重叠', () => {
  // 每段 2 句（≈42 token）→ 一块能装 2 段，于是重叠才有东西可搬。
  // 如果每段自己就占满上限，块=段，重叠无处可放（这是刻意的行为，见 packUnits 注释）
  const text = chineseParagraphs(6, 2);

  it('每块不超过 maxTokens（默认 400）', () => {
    const chunks = chunkPlainText(text, { maxTokens: 120, overlapTokens: 30 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.token_count).toBeLessThanOrEqual(120);
    }
  });

  it('重叠生效：后一块的开头能在前一块的结尾找到', () => {
    const chunks = chunkPlainText(text, { maxTokens: 100, overlapTokens: 45 });
    expect(chunks.length).toBeGreaterThan(1);
    const first = chunks[0];
    const lastSentence = first.content.split('。').filter(Boolean).pop() + '。';
    expect(chunks[1].content).toContain(lastSentence);
  });

  it('overlapTokens = 0 时相邻块不共享句子', () => {
    const chunks = chunkPlainText(text, { maxTokens: 100, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    const lastSentence = chunks[0].content.split('。').filter(Boolean).pop() + '。';
    expect(chunks[1].content).not.toContain(lastSentence);
  });

  it('内容不丢：所有句子都能在拼起来的块里找到', () => {
    const chunks = chunkPlainText(text, { maxTokens: 120, overlapTokens: 0 });
    const joined = chunks.map((c) => c.content).join('');
    for (const sentence of text.split('\n\n').join('').split('。').filter(Boolean)) {
      expect(joined).toContain(sentence);
    }
  });

  it('不产生空块，也不会自我复制（相邻块内容不相同）', () => {
    const chunks = chunkPlainText(text, { maxTokens: 60, overlapTokens: 50 });
    for (const c of chunks) expect(c.content.trim().length).toBeGreaterThan(0);
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i].content).not.toBe(chunks[i - 1].content);
    }
  });

  it('默认值符合常量声明', () => {
    expect(DEFAULT_MAX_TOKENS).toBe(400);
    expect(DEFAULT_OVERLAP_TOKENS).toBe(60);
  });
});

describe('chunker / 中文长文本与硬切', () => {
  it('中文没有空格也能切（按标点）', () => {
    const text = chineseParagraphs(4, 6);
    const chunks = chunkPlainText(text, { maxTokens: 100, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.token_count).toBeLessThanOrEqual(100);
    }
  });

  it('一个超长句子（没有标点）走硬切且被标记', () => {
    const long = '甲'.repeat(500);
    const chunks = chunkPlainText(long, { maxTokens: 50, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks[0].oversized).toBe(true);
    expect(chunks.map((c) => c.content).join('')).toBe(long);
  });

  it('空白输入返回空数组', () => {
    expect(chunkPlainText('   \n\n  ', {})).toEqual([]);
    expect(chunkPlainText('', {})).toEqual([]);
  });
});

describe('chunker / markdown 代码围栏', () => {
  const md = [
    '# 指南',
    '',
    '这是说明文字。'.repeat(30),
    '',
    '```js',
    'function add(a, b) {',
    '  return a + b;',
    '}',
    '',
    'const x = add(1, 2);',
    'console.log(x);',
    '```',
    '',
    '围栏之后还有一段说明。'.repeat(30),
  ].join('\n');

  it('代码围栏不会被切碎（整块落在同一个 chunk 里）', () => {
    const parsed = parseMarkdown(md);
    const { chunks } = chunkDocument(parsed, { documentId: 'doc_x', source: { filename: 'a.md', format: 'md' }, maxTokens: 100 });
    const withCode = chunks.filter((c) => c.content.includes('function add(a, b) {'));
    expect(withCode.length).toBeGreaterThanOrEqual(1);
    // 关键断言：凡是含代码的块，从 ```js 到下一个 ``` 之间必须是**完整**的函数体
    for (const c of withCode) {
      const start = c.content.indexOf('```js');
      const end = c.content.indexOf('```', start + 5);
      expect(c.content).toContain('```js');
      expect(end).toBeGreaterThan(start);
      const block = c.content.slice(start, end);
      expect(block).toContain('function add(a, b) {');
      expect(block).toContain('console.log(x);');
    }
    // 不能出现"只有开头没有结尾"的块
    for (const c of chunks) {
      if (!c.content.includes('```')) continue;
      const opens = (c.content.match(/```/g) || []).length;
      expect(opens % 2).toBe(0);
    }
  });

  it('splitIntoUnits 把围栏当原子单元', () => {
    const units = splitIntoUnits('前文\n\n```\ncode line\n```\n\n后文', { maxTokens: 100 });
    const fence = units.find((u) => u.protected);
    expect(fence).toBeTruthy();
    expect(fence.text).toContain('code line');
  });
});

describe('chunker / chunkDocument', () => {
  it('chunk_index 连续且与正文顺序一致', () => {
    const parsed = parseTxt(('段落一的内容。'.repeat(20) + '\n\n' + '段落二的内容。'.repeat(20) + '\n\n' + '段落三的内容。'.repeat(20)));
    const { chunks } = chunkDocument(parsed, { documentId: 'doc_ab', source: { filename: 'a.txt', format: 'txt' }, maxTokens: 80 });
    expect(chunks.length).toBeGreaterThan(2);
    chunks.forEach((c, i) => {
      expect(c.chunk_index).toBe(i);
      expect(c.id).toBe('doc_ab#' + String(i).padStart(4, '0'));
      expect(c.document_id).toBe('doc_ab');
    });
    // 顺序：段落一 的内容出现在段落三 之前
    const joined = chunks.map((c) => c.content).join('\n');
    expect(joined.indexOf('段落一')).toBeLessThan(joined.indexOf('段落三'));
  });

  it('chunk 带齐 schema 字段', () => {
    const parsed = parseTxt('一段足够长的说明文字。'.repeat(30));
    const { chunks } = chunkDocument(parsed, { documentId: 'doc_1', source: { kind: 'file', filename: 'a.txt', path: 'D:/d/a.txt', extension: 'txt', format: 'txt' }, now: '2024-05-05T00:00:00.000Z' });
    const c = chunks[0];
    for (const key of ['id', 'document_id', 'content', 'title', 'source', 'chunk_index', 'metadata', 'created_at', 'updated_at', 'embedding']) {
      expect(Object.prototype.hasOwnProperty.call(c, key)).toBe(true);
    }
    expect(c.created_at).toBe('2024-05-05T00:00:00.000Z');
    expect(c.embedding).toBeNull();
    expect(c.source.filename).toBe('a.txt');
    expect(c.metadata.token_count).toBeGreaterThan(0);
  });

  it('markdown 章节块带标题与页码占位', () => {
    const parsed = parseMarkdown('# 标题A\n\n' + '甲。'.repeat(50) + '\n\n## 小节B\n\n' + '乙。'.repeat(50));
    const { chunks } = chunkDocument(parsed, { documentId: 'doc_md', source: { filename: 'a.md', format: 'md' }, maxTokens: 120 });
    const titles = new Set(chunks.map((c) => c.title));
    expect(titles.has('标题A')).toBe(true);
    expect(titles.has('小节B')).toBe(true);
    expect(chunks.every((c) => c.page === null)).toBe(true);
  });

  it('json 条目合并到上限，但保留 key 路径', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ q: '问题' + i, a: '答案' + i }));
    const parsed = { format: 'json', title: '问答', text: '', blocks: items.map((it, i) => ({ text: '$.q: ' + it.q + '\n$.a: ' + it.a, path: '$[' + i + ']', page: null, merge: true })) };
    const { chunks } = chunkDocument(parsed, { documentId: 'doc_j', source: { filename: 'a.json', format: 'json' }, maxTokens: 60 });
    expect(chunks.length).toBeLessThan(items.length);
    expect(chunks[0].metadata.json_path).toBeTruthy();
  });

  it('空文档不产 chunk', () => {
    const { chunks } = chunkDocument({ format: 'txt', text: '', blocks: [] }, { documentId: 'doc_e' });
    expect(chunks).toEqual([]);
  });
});

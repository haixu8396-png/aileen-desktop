// ============================================================
// R5 单测：知识库生成器（纯函数）
//   slug / 大纲解析 / 章节解析 / 索引 / 术语表 / 清单 / 校验 / 差异
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  normalizeSpec, slugify, buildOutlineMessages, parseOutline,
  buildChapterMessages, parseChapter, buildIndexMarkdown, buildGlossaryMarkdown,
  buildManifest, validateKnowledgeBase, diffManifests, DEPTHS, MAX_CHAPTERS,
} from '../../src/knowledge/generator.js';

const OUTLINE_JSON = JSON.stringify({
  title: 'Rust 所有权',
  tags: ['rust', '内存'],
  chapters: [
    { title: '所有权是什么', goal: '讲清 move 与作用域', keyPoints: ['栈与堆', 'drop'] },
    { title: '借用与生命周期', goal: '讲清引用规则', keyPoints: ['&', '&mut'] },
  ],
  glossary: [{ term: '所有权', definition: '值有唯一负责释放的变量' }],
});

describe('spec 归一化', () => {
  it('默认值合理，章数收敛', () => {
    const s = normalizeSpec({ topic: 'Rust 所有权' });
    expect(s.depth).toBe('standard');
    expect(s.chapters).toBe(4);
    expect(s.audience).toBeTruthy();
    expect(normalizeSpec({ topic: 'x', chapters: 99 }).chapters).toBe(MAX_CHAPTERS);
    expect(normalizeSpec({ topic: 'x', chapters: 0 }).chapters).toBe(1);
  });

  it('非法深度退回 standard', () => {
    expect(normalizeSpec({ topic: 'x', depth: 'lol' }).depth).toBe('standard');
    expect(DEPTHS).toContain(normalizeSpec({ topic: 'x', depth: 'deep' }).depth);
  });

  it('slug 稳定、可用作目录名', () => {
    expect(slugify('Rust 所有权')).toBe(slugify('Rust 所有权'));
    expect(slugify('Hello World!')).toBe('hello-world');
    expect(slugify('!!!')).toMatch(/^topic-/);
  });
});

describe('大纲', () => {
  it('提示词要求 JSON + 由浅入深 + 不写正文', () => {
    const msgs = buildOutlineMessages({ topic: 'Rust 所有权', chapters: 2 });
    expect(msgs[0].content).toContain('chapters');
    expect(msgs[0].content).toContain('不要写正文');
    expect(msgs[1].content).toContain('Rust 所有权');
  });

  it('解析出章节与术语，并补 index/slug', () => {
    const o = parseOutline(OUTLINE_JSON);
    expect(o.title).toBe('Rust 所有权');
    expect(o.chapters).toHaveLength(2);
    expect(o.chapters[0].index).toBe(1);
    expect(o.chapters[0].slug).toBeTruthy();
    expect(o.glossary[0].term).toBe('所有权');
  });

  it('没有章节 / 不是 JSON → null', () => {
    expect(parseOutline('随便说说')).toBeNull();
    expect(parseOutline('{"chapters":[]}')).toBeNull();
    expect(parseOutline(JSON.stringify({ chapters: [{ title: '' }] }))).toBeNull();
  });
});

describe('章节', () => {
  it('提示词只写这一章，并要求标来源、不编造', () => {
    const spec = normalizeSpec({ topic: 'Rust' });
    const outline = parseOutline(OUTLINE_JSON);
    const msgs = buildChapterMessages(spec, outline, outline.chapters[0], { sources: [{ title: '官方文档', url: 'https://doc.rust-lang.org/' }] });
    expect(msgs[0].content).toContain('不要写别的章节');
    expect(msgs[0].content).toContain('[1]');
    expect(msgs[1].content).toContain('所有权是什么');
  });

  it('解析 Markdown：剥最外层围栏、统计标题与要点', () => {
    const md = '# 所有权\n\n第一段内容足够长，才不会被当成空章节。\n\n## 小节\n\n- 要点一\n- 要点二\n';
    const r = parseChapter('```md\n' + md + '\n```');
    expect(r.markdown.startsWith('# 所有权')).toBe(true);
    expect(r.headings).toBe(2);
    expect(r.bullets).toBe(2);
    expect(r.chars).toBeGreaterThan(20);
  });

  it('太短/空 → null', () => {
    expect(parseChapter('')).toBeNull();
    expect(parseChapter('太短了')).toBeNull();
  });
});

describe('索引与术语表', () => {
  it('索引里每章一个链接，链接路径可点', () => {
    const o = parseOutline(OUTLINE_JSON);
    const md = buildIndexMarkdown({ title: 'Rust 所有权', outline: o });
    expect(md).toContain('[1. 所有权是什么](topics/');
    expect(md).toContain('.md)');
    expect(md).toContain('标签：rust、内存');
  });

  it('术语表空的时候也给一句人话', () => {
    expect(buildGlossaryMarkdown([])).toContain('暂无术语');
    expect(buildGlossaryMarkdown([{ term: 'A', definition: 'B' }])).toContain('**A**：B');
  });
});

describe('清单与校验', () => {
  function build(files, sources = [{ title: '官方文档', url: 'https://x', type: 'official' }]) {
    const spec = normalizeSpec({ topic: 'Rust', chapters: 2 });
    const o = parseOutline(OUTLINE_JSON);
    return buildManifest({ spec, outline: o, files, sources, now: '2026-11-20T00:00:00.000Z' });
  }

  const goodMd = '# 所有权\n\n' + '内容'.repeat(150) + '\n';

  it('清单记录 origin / 来源 / 生成器版本', () => {
    const m = build([{ slug: 'a', file: 'topics/a.md', chars: 10 }]);
    expect(m.origin).toBe('ai_generated');
    expect(m.generatedBy.app).toBe('aileen');
    expect(m.sources[0].type).toBe('official');
    expect(m.chapters.length).toBe(2);
  });

  it('不合格的库：缺文件 / 太短 / 缺标题 / 重复标题', () => {
    const m = build([]);
    m.chapters = [
      { index: 1, slug: 'a', title: '同名', file: 'topics/a.md' },
      { index: 2, slug: 'b', title: '同名', file: 'topics/b.md' },
      { index: 3, slug: 'c', title: '缺失', file: 'topics/c.md' },
    ];
    const r = validateKnowledgeBase({ manifest: m, files: [{ slug: 'a', markdown: '短' }, { slug: 'b', markdown: goodMd }] });
    const codes = r.problems.map((p) => p.code);
    expect(r.ok).toBe(false);
    expect(codes).toContain('chapter-too-short');
    expect(codes).toContain('duplicate-title');
    expect(codes).toContain('missing-file');
  });

  it('引用标记超出来源数量会被抓出来', () => {
    const m = build([{ slug: 'a', file: 'topics/a.md', chars: 1 }], []);
    m.chapters = [{ index: 1, slug: 'a', title: 'A', file: 'topics/a.md' }];
    const r = validateKnowledgeBase({ manifest: m, files: [{ slug: 'a', markdown: goodMd + '见 [3]' }] });
    expect(r.problems.map((p) => p.code)).toContain('citation-without-source');
  });

  it('合格的库通过', () => {
    const m = build([{ slug: 'a', file: 'topics/a.md', chars: goodMd.length }]);
    m.chapters = [{ index: 1, slug: 'a', title: 'A', file: 'topics/a.md' }];
    const r = validateKnowledgeBase({ manifest: m, files: [{ slug: 'a', markdown: goodMd }] });
    expect(r.ok).toBe(true);
  });
});

describe('差异', () => {
  it('新增 / 删除 / 改动分别列出', () => {
    const prev = { chapters: [{ slug: 'a', title: 'A', chars: 10 }, { slug: 'b', title: 'B', chars: 20 }] };
    const next = { chapters: [{ slug: 'a', title: 'A', chars: 30 }, { slug: 'c', title: 'C', chars: 5 }] };
    const d = diffManifests(prev, next);
    expect(d.added).toEqual(['C']);
    expect(d.removed).toEqual(['B']);
    expect(d.changed).toEqual(['A']);
    expect(d.changedCount).toBe(3);
  });

  it('没有上一版时差异为空', () => {
    expect(diffManifests(null, { chapters: [] }).changedCount).toBe(0);
  });
});

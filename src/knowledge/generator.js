// ============================================================
// AI 知识库生成器（任务书 R5）
//
// 这一层是**纯函数 + 注入 LLM**：提示词、解析、校验、索引、清单、差异全在这里，
// 落盘与检索入库在 src/lib/knowledge-gen.js（那层才碰 window.api.storeFs 与引擎）。
//
// 设计要点（都是任务书明确要求的）：
//   · 先大纲、后全文：大纲可以被人改，改完再生成（不一次烧掉全部额度）；
//   · 一章一个 Markdown 文件：避免超长单文件，也方便单章重生成；
//   · 每篇都带来源登记（user_file / ai_generated / web_research / manual_edit）；
//   · 生成前先校验（空章节 / 断链 / 重复 / 缺引用），不合格不发布；
//   · 更新保留旧快照、不静默覆盖人工编辑（diff 交给界面展示）。
// ============================================================

export const DEPTHS = ['overview', 'standard', 'deep'];
export const MAX_CHAPTERS = 12;

function str(v, n = 400) {
  return String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, n);
}

export function slugify(title) {
  const s = String(title || '').trim().toLowerCase();
  const ascii = s.replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
  if (ascii) return ascii.slice(0, 60);
  return 'topic-' + Math.abs(hash(String(title || ''))).toString(36).slice(0, 8);
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

export function normalizeSpec(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const n = Number(r.chapters);
  const chapters = Number.isFinite(n)
    ? Math.max(1, Math.min(MAX_CHAPTERS, Math.round(n)))
    : 4;
  return {
    topic: str(r.topic, 200),
    audience: str(r.audience, 120) || '普通读者',
    depth: DEPTHS.includes(r.depth) ? r.depth : 'standard',
    language: str(r.language, 8) || 'zh',
    scope: str(r.scope, 600),
    chapters,
    needWeb: r.needWeb === true,
    title: str(r.title, 120) || str(r.topic, 120),
    baseSlug: slugify(r.topic || r.title || 'knowledge'),
  };
}

/** 大纲提示词：先给目录、每章目标与前置知识，再让人改 */
export function buildOutlineMessages(spec) {
  const s = normalizeSpec(spec);
  const langName = s.language === 'en' ? 'English' : (s.language === 'ja' ? '日本語' : '简体中文');
  const depthNote = {
    overview: '偏概览：每章 300~600 字，抓主干。',
    standard: '标准深度：每章 600~1200 字，够自学。',
    deep: '偏深入：每章 1200~2000 字，含机制/边界/常见误区。',
  }[s.depth];
  return [
    {
      role: 'system',
      content: [
        '你在为一个本地知识库设计目录大纲。只输出一个 JSON 对象，不要解释、不要代码围栏。',
        '{',
        '  "title": "库的标题",',
        '  "tags": ["标签"],',
        '  "chapters": [ { "title": "章节标题", "goal": "这一章要讲清什么", "keyPoints": ["要点"] } ],',
        '  "glossary": [ { "term": "术语", "definition": "一句话解释" } ]',
        '}',
        '规则：',
        '1. 章节数按用户要求（' + s.chapters + ' 章左右），由浅入深，不要互相重复。',
        '2. 每章只有一个明确主题；章节标题要能直接当文件名用。',
        '3. ' + depthNote,
        '4. 用 ' + langName + ' 写。',
        '5. 不要写正文，只要目录。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '主题：' + s.topic,
        '读者：' + s.audience,
        '语言：' + langName,
        '范围：' + (s.scope || '（未指定）'),
        s.needWeb ? '需要联网资料：是（资料不足时在 keyPoints 里注明「待补充」）' : '需要联网资料：否',
      ].join('\n'),
    },
  ];
}

export function parseOutline(raw) {
  const text = String(raw == null ? '' : raw);
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  let obj = null;
  try { obj = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const chapters = (Array.isArray(obj.chapters) ? obj.chapters : [])
    .map((c, i) => {
      const x = (c && typeof c === 'object') ? c : { title: String(c) };
      const title = str(x.title, 120);
      if (!title) return null;
      return {
        index: i + 1,
        slug: slugify(title),
        title,
        goal: str(x.goal, 400),
        keyPoints: (Array.isArray(x.keyPoints) ? x.keyPoints : []).map((k) => str(k, 200)).filter(Boolean).slice(0, 12),
      };
    })
    .filter(Boolean)
    .slice(0, MAX_CHAPTERS);
  if (!chapters.length) return null;
  return {
    title: str(obj.title, 120) || chapters[0].title,
    tags: (Array.isArray(obj.tags) ? obj.tags : []).map((t) => str(t, 40)).filter(Boolean).slice(0, 12),
    chapters,
    glossary: (Array.isArray(obj.glossary) ? obj.glossary : []).map((g) => {
      const x = (g && typeof g === 'object') ? g : { term: String(g) };
      return { term: str(x.term, 60), definition: str(x.definition, 300) };
    }).filter((g) => g.term && g.definition).slice(0, 60),
  };
}

/** 单章正文 */
export function buildChapterMessages(spec, outline, chapter, { sources = [] } = {}) {
  const s = normalizeSpec(spec);
  const langName = s.language === 'en' ? 'English' : (s.language === 'ja' ? '日本語' : '简体中文');
  const blocks = [
    '你正在为本地知识库写一章 Markdown 正文。',
    '== 硬规矩 ==',
    '1. 只写这一章，不要写别的章节，也不要写目录（目录由系统生成）。',
    '2. 用 Markdown：一个 # 标题（就是章节标题）+ 若干 ## 小节；需要时用表格/代码块。',
    '3. 开头用一两句话说明这章解决什么问题；结尾列出 3 条以内的要点。',
    '4. 不确定的内容写「（待确认）」，不要编造数据、日期、引用。',
    '5. 引用外部资料时在句末标注来源编号，例如 [1]；没有来源就不要标。',
    '6. 用 ' + langName + ' 写。',
  ];
  if (sources.length) {
    blocks.push('【可用来源】');
    sources.slice(0, 8).forEach((src, i) => {
      const x = (src && typeof src === 'object') ? src : { title: String(src) };
      blocks.push('[' + (i + 1) + '] ' + str(x.title, 160)
        + (x.url ? ' ' + str(x.url, 300) : '')
        + (x.snippet ? '\n  ' + str(x.snippet, 300) : ''));
    });
  }
  const outlineText = outline.chapters.map((c) => (c.index === chapter.index ? '→ ' : '  ') + c.index + '. ' + c.title).join('\n');
  return [
    { role: 'system', content: blocks.join('\n') },
    {
      role: 'user',
      content: [
        '库：' + outline.title,
        '读者：' + s.audience,
        '深度：' + s.depth,
        '目录：',
        outlineText,
        '',
        '这一章：' + chapter.index + '. ' + chapter.title,
        chapter.goal ? '目标：' + chapter.goal : '',
        chapter.keyPoints.length ? '要覆盖的要点：\n- ' + chapter.keyPoints.join('\n- ') : '',
        s.scope ? '整体范围：' + s.scope : '',
      ].filter(Boolean).join('\n'),
    },
  ];
}

export function parseChapter(raw) {
  const text = String(raw == null ? '' : raw).replace(/\r\n/g, '\n').trim();
  if (!text) return null;
  // 模型偶尔会套一层围栏：只剥最外层，正文里的代码块要保留
  let md = text;
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(md);
  if (fence) md = fence[1].trim();
  if (md.length < 40) return null;
  const lines = md.split('\n');
  const headings = lines.filter((l) => /^#{1,3}\s+/.test(l)).length;
  const bullets = lines.filter((l) => /^[-*]\s+|^\d+\.\s+/.test(l)).length;
  return {
    markdown: md,
    headings,
    bullets,
    chars: md.length,
    summary: str(lines.filter((l) => l.trim() && !l.startsWith('#')).slice(0, 2).join(' '), 400),
  };
}

export function buildIndexMarkdown({ title, outline, basePath = '' }) {
  const lines = ['# ' + (title || outline.title), ''];
  if (outline.tags && outline.tags.length) lines.push('标签：' + outline.tags.join('、'), '');
  lines.push('## 目录', '');
  for (const c of outline.chapters) {
    lines.push('- [' + c.index + '. ' + c.title + '](' + basePath + 'topics/' + c.slug + '.md)'
      + (c.goal ? ' —— ' + c.goal : ''));
  }
  lines.push('', '## 说明', '', '这个知识库由 AILEEN 生成，每章一个 Markdown 文件；来源登记在 `sources/source-register.json`。', '');
  return lines.join('\n');
}

export function buildGlossaryMarkdown(glossary) {
  const list = Array.isArray(glossary) ? glossary : [];
  const lines = ['# 术语表', ''];
  if (!list.length) lines.push('（暂无术语）');
  for (const g of list) lines.push('- **' + g.term + '**：' + g.definition);
  lines.push('');
  return lines.join('\n');
}

export function buildManifest({ spec, outline, files = [], sources = [], now = new Date().toISOString() }) {
  const s = normalizeSpec(spec);
  return {
    version: 1,
    title: outline.title || s.title,
    slug: s.baseSlug,
    createdAt: now,
    updatedAt: now,
    spec: {
      topic: s.topic, audience: s.audience, depth: s.depth,
      language: s.language, scope: s.scope, needWeb: s.needWeb,
    },
    tags: outline.tags || [],
    chapters: (outline.chapters || []).map((c) => ({
      index: c.index, slug: c.slug, title: c.title,
      file: 'topics/' + c.slug + '.md',
      goal: c.goal || '',
      chars: Number((files.find((f) => f.slug === c.slug) || {}).chars) || 0,
    })),
    files: files.map((f) => ({ slug: f.slug, file: f.file, chars: f.chars || 0, sha: f.sha || '' })),
    sources: (sources || []).map((x) => ({
      title: str(x.title, 200), url: str(x.url, 500),
      type: str(x.type || 'ai_generated', 20), retrievedAt: str(x.retrievedAt, 40),
    })),
    origin: 'ai_generated',
    generatedBy: { app: 'aileen', version: '0.7.9' },
  };
}

/**
 * 生成前/发布前校验：空章节、断链、重复标题、缺来源、长度异常。
 * 不通过就**不发布**（返回 problems，界面据此让用户重生成某章）。
 */
export function validateKnowledgeBase({ manifest, files = [] } = {}) {
  const problems = [];
  const m = manifest || {};
  const chapters = Array.isArray(m.chapters) ? m.chapters : [];
  const bySlug = new Map(files.map((f) => [f.slug, f]));
  const seen = new Set();
  for (const c of chapters) {
    if (!c.file) problems.push({ code: 'missing-file-ref', detail: c.title });
    const f = bySlug.get(c.slug);
    if (!f) { problems.push({ code: 'missing-file', detail: 'topics/' + c.slug + '.md' }); continue; }
    const md = String(f.markdown || '');
    if (md.replace(/\s+/g, '').length < 200) problems.push({ code: 'chapter-too-short', detail: c.title });
    if (!/^#\s+/m.test(md)) problems.push({ code: 'missing-heading', detail: c.title });
    const key = String(c.title).trim().toLowerCase();
    if (seen.has(key)) problems.push({ code: 'duplicate-title', detail: c.title });
    seen.add(key);
    // 断链：只检查内部 topics/ 链接
    const links = md.match(/\]\((topics\/[^)]+\.md)\)/g) || [];
    for (const l of links) {
      const target = l.slice(2, -1).replace(/^topics\//, '').replace(/\.md$/, '');
      if (!chapters.some((x) => x.slug === target)) problems.push({ code: 'broken-link', detail: l });
    }
  }
  // 引用标记 [n] 需要有对应来源
  const srcCount = Array.isArray(m.sources) ? m.sources.length : 0;
  for (const f of files) {
    const marks = String(f.markdown || '').match(/\[(\d{1,2})\]/g) || [];
    for (const mk of marks) {
      const n = Number(mk.slice(1, -1));
      if (n > Math.max(srcCount, 0) && n > 0) {
        problems.push({ code: 'citation-without-source', detail: '[' + n + ']' });
        break;
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

/** 两个 manifest 的差异：新增/删除/改动（改动用 chars 粗判，够界面展示） */
export function diffManifests(prev, next) {
  const a = (prev && Array.isArray(prev.chapters)) ? prev.chapters : [];
  const b = (next && Array.isArray(next.chapters)) ? next.chapters : [];
  const mapA = new Map(a.map((c) => [c.slug, c]));
  const mapB = new Map(b.map((c) => [c.slug, c]));
  const added = b.filter((c) => !mapA.has(c.slug)).map((c) => c.title);
  const removed = a.filter((c) => !mapB.has(c.slug)).map((c) => c.title);
  const changed = b.filter((c) => mapA.has(c.slug) && Number(c.chars || 0) !== Number(mapA.get(c.slug).chars || 0))
    .map((c) => c.title);
  return { added, removed, changed, changedCount: added.length + removed.length + changed.length };
}

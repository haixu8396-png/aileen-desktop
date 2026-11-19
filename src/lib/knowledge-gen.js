// ============================================================
// 知识库生成编排（R5 的「手脚」）
//
// 分工：generator.js 只管提示词/解析/校验/清单（纯函数）；
// 这一层负责：调 LLM、落盘（store:fs 的 knowledge 根）、入库（检索引擎）、版本快照。
//
// 目录结构（任务书 6.2）：
//   kol/<slug>/manifest.json
//   kol/<slug>/index.md
//   kol/<slug>/glossary.md
//   kol/<slug>/topics/<chapter>.md
//   kol/<slug>/sources/source-register.json
//   kol/<slug>/history/<iso>.json      ← 更新前的旧清单快照（不静默覆盖）
// ============================================================
import { streamChat } from './llm.js';
import { t } from './i18n.js';
import { getSettings, hasApiKey } from './settings.js';
import { ensureEngines } from './memory-host.js';
import {
  normalizeSpec, buildOutlineMessages, parseOutline, buildChapterMessages, parseChapter,
  buildIndexMarkdown, buildGlossaryMarkdown, buildManifest, validateKnowledgeBase, diffManifests,
} from '../knowledge/generator.js';

const ROOT = 'knowledge';
const BASE = 'kol';

function storeFs(payload) {
  const api = (typeof window !== 'undefined' && window.api) ? window.api : {};
  if (typeof api.storeFs !== 'function') throw new Error('当前环境没有存储通道');
  return api.storeFs(Object.assign({ root: ROOT }, payload));
}

async function writeText(relPath, text) {
  return storeFs({ op: 'writeText', path: relPath, text: String(text == null ? '' : text) });
}

async function readText(relPath) {
  const res = await storeFs({ op: 'readText', path: relPath });
  return res && typeof res.text === 'string' ? res.text : '';
}

async function mkdir(relPath) {
  return storeFs({ op: 'mkdir', path: relPath });
}

async function listDir(relPath) {
  const res = await storeFs({ op: 'list', path: relPath });
  return (res && res.entries) || [];
}

async function exists(relPath) {
  const res = await storeFs({ op: 'exists', path: relPath });
  return !!(res && res.exists);
}

/** 一次非流式 LLM 调用（给人看的大段生成，token 给足） */
async function ask(messages, maxTokens = 2048) {
  if (!hasApiKey('llm')) throw new Error(t('chat.needKeyHint'));
  const s = getSettings();
  let out = '';
  await streamChat({
    messages,
    settings: Object.assign({}, s, { llm: Object.assign({}, s.llm, { maxTokens }) }),
    onDelta: (d) => { out += d; },
  });
  return out;
}

function slugOf(spec) {
  return normalizeSpec(spec).baseSlug;
}

function libPath(slug, rel = '') {
  return BASE + '/' + slug + (rel ? '/' + rel : '');
}

/** 第一步：大纲（生成之后**由用户确认/修改**，不直接烧全文） */
export async function generateOutline(spec) {
  const s = normalizeSpec(spec);
  if (!s.topic) throw new Error(t('kol.needTopic'));
  const raw = await ask(buildOutlineMessages(s), 1500);
  const outline = parseOutline(raw);
  if (!outline) {
    const err = new Error(t('kol.outlineFail'));
    err.code = 'OUTLINE_UNPARSABLE';
    throw err;
  }
  return outline;
}

function shaOf(text) {
  let h = 2166136261;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 第二步：按大纲生成全文并落盘 + 入库。
 *
 * @param {object} spec
 * @param {object} outline  用户确认过的大纲
 * @param {object} opts     { sources, onProgress }
 */
export async function generateKnowledgeBase(spec, outline, opts = {}) {
  const s = normalizeSpec(spec);
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const sources = Array.isArray(opts.sources) ? opts.sources : [];
  const slug = s.baseSlug;
  const files = [];

  for (const chapter of outline.chapters) {
    onProgress({ stage: 'chapter', index: chapter.index, total: outline.chapters.length, title: chapter.title });
    // 每章一次调用：失败不整体崩，记下来让用户重生成这一章
    // eslint-disable-next-line no-await-in-loop
    const raw = await ask(buildChapterMessages(s, outline, chapter, { sources }), 2600);
    const parsed = parseChapter(raw);
    if (!parsed) {
      files.push({ slug: chapter.slug, file: 'topics/' + chapter.slug + '.md', markdown: '', chars: 0, sha: '', error: 'EMPTY_CHAPTER' });
      continue;
    }
    files.push({
      slug: chapter.slug,
      file: 'topics/' + chapter.slug + '.md',
      markdown: parsed.markdown,
      chars: parsed.chars,
      sha: shaOf(parsed.markdown),
    });
  }

  const nowIso = new Date().toISOString();
  const manifest = buildManifest({
    spec: s,
    outline,
    files: files.map((f) => ({ slug: f.slug, file: f.file, chars: f.chars, sha: f.sha })),
    sources: sources.length ? sources : [{ title: 'AI 生成（无外部来源）', type: 'ai_generated', url: '', retrievedAt: nowIso }],
    now: nowIso,
  });
  const check = validateKnowledgeBase({ manifest, files });

  // 先落盘：即使有校验问题，也把能保存的存下来（用户可以单章重生成）
  await mkdir(libPath(slug));
  await mkdir(libPath(slug, 'topics'));
  await mkdir(libPath(slug, 'sources'));
  for (const f of files) {
    if (!f.markdown) continue;
    // eslint-disable-next-line no-await-in-loop
    await writeText(libPath(slug, f.file), f.markdown);
  }
  await writeText(libPath(slug, 'index.md'), buildIndexMarkdown({ title: manifest.title, outline }));
  await writeText(libPath(slug, 'glossary.md'), buildGlossaryMarkdown(outline.glossary));
  await writeText(libPath(slug, 'sources/source-register.json'), JSON.stringify({
    version: 1, generatedAt: nowIso, sources: manifest.sources,
  }, null, 2));
  await writeText(libPath(slug, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // 入库：逐章 addText（知识库检索走同一套 chunk/向量流程）
  let imported = 0;
  const importErrors = [];
  try {
    const { knowledge } = ensureEngines();
    if (knowledge) {
      for (const f of files) {
        if (!f.markdown) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await knowledge.addText({ name: manifest.title + ' · ' + f.slug, text: f.markdown, tags: [slug] });
          imported += 1;
        } catch (err) {
          importErrors.push({ slug: f.slug, error: String((err && err.message) || err) });
        }
      }
    }
  } catch (err) {
    importErrors.push({ slug: '*', error: String((err && err.message) || err) });
  }

  return {
    slug,
    manifest,
    files,
    problems: check.problems,
    ok: check.ok && files.every((f) => !!f.markdown),
    imported,
    importErrors,
  };
}

/** 列出已经生成的库（读 kol/<slug>/manifest.json） */
export async function listKnowledgeBases() {
  let entries = [];
  try {
    entries = await listDir(BASE);
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory) continue;
    const rel = BASE + '/' + e.name + '/manifest.json';
    // eslint-disable-next-line no-await-in-loop
    if (!(await exists(rel))) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const raw = await readText(rel);
      const m = JSON.parse(raw);
      out.push({ slug: e.name, title: m.title || e.name, chapters: (m.chapters || []).length, updatedAt: m.updatedAt || '' });
    } catch { /* 坏清单跳过 */ }
  }
  return out;
}

export async function loadManifest(slug) {
  const raw = await readText(libPath(slug, 'manifest.json'));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * 更新一个已有库：先快照旧清单，再整体重生成，最后给出差异。
 * 不静默覆盖：旧快照留在 history/ 里，界面把差异展示给用户。
 */
export async function refreshKnowledgeBase(slug, spec, outline, opts = {}) {
  const prev = await loadManifest(slug);
  if (prev) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await mkdir(libPath(slug, 'history'));
    await writeText(libPath(slug, 'history/' + stamp + '.json'), JSON.stringify(prev, null, 2));
  }
  const result = await generateKnowledgeBase(spec, outline, opts);
  return Object.assign({}, result, {
    diff: prev ? diffManifests(prev, result.manifest) : { added: [], removed: [], changed: [], changedCount: 0 },
  });
}

/** 删除一个库（只删自己生成的文件：topics/*.md、index、glossary、manifest、sources、history） */
export async function deleteKnowledgeBase(slug) {
  const files = ['index.md', 'glossary.md', 'manifest.json', 'sources/source-register.json'];
  for (const f of files) {
    // eslint-disable-next-line no-await-in-loop
    try { await storeFs({ op: 'remove', path: libPath(slug, f) }); } catch { /* 不存在就算了 */ }
  }
  try {
    const topics = await listDir(libPath(slug, 'topics'));
    for (const e of topics) {
      if (e.isDirectory) continue;
      // eslint-disable-next-line no-await-in-loop
      try { await storeFs({ op: 'remove', path: libPath(slug, 'topics/' + e.name) }); } catch { /* 忽略 */ }
    }
    // eslint-disable-next-line no-await-in-loop
    try { await storeFs({ op: 'remove', path: libPath(slug, 'topics') }); } catch { /* 非空就算了 */ }
  } catch { /* 忽略 */ }
  for (const dir of ['sources', 'history', '']) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await storeFs({ op: 'remove', path: libPath(slug, dir) });
    } catch { /* 忽略 */ }
  }
  return { ok: true, slug };
}

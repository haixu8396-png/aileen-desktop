// ============================================================
// 知识库生成界面（R5）
//
// 流程（任务书 6.1）：
//   填主题/用途/受众/深度/语言/章数 → 生成大纲 → 用户看/改大纲 → 生成全文
//   → 落盘 + 入库 → 展示校验问题与来源 → 想改就单章重生成
//
// 这一层只管界面与调用顺序；生成/落盘/校验在 knowledge-gen.js 与 generator.js。
// ============================================================
import { $, toast } from './dom.js';
import { t, getLang } from './i18n.js';
import {
  generateOutline, generateKnowledgeBase, listKnowledgeBases, loadManifest,
  refreshKnowledgeBase, deleteKnowledgeBase,
} from './knowledge-gen.js';
import { collectSources } from './web.js';
import { parseOutline } from '../knowledge/generator.js';

let currentSpec = null;
let currentOutline = null;
let busy = false;

function specFromForm() {
  return {
    topic: ($('kol-topic') || {}).value || '',
    audience: ($('kol-audience') || {}).value || '',
    depth: ($('kol-depth') || {}).value || 'standard',
    language: ($('kol-lang') || {}).value || getLang(),
    chapters: Number((($('kol-chapters') || {}).value) || 4),
    scope: ($('kol-scope') || {}).value || '',
  };
}

function setBusy(on, text) {
  busy = !!on;
  const btnA = $('btn-kol-outline');
  const btnB = $('btn-kol-generate');
  if (btnA) btnA.disabled = on;
  if (btnB) btnB.disabled = on || !currentOutline;
  const box = $('kol-progress');
  if (box && text) box.textContent = text;
}

function renderOutline(outline) {
  currentOutline = outline;
  const box = $('kol-outline');
  if (box) {
    box.value = JSON.stringify({
      title: outline.title,
      tags: outline.tags,
      chapters: outline.chapters.map((c) => ({ title: c.title, goal: c.goal, keyPoints: c.keyPoints })),
      glossary: outline.glossary,
    }, null, 2);
  }
  const btn = $('btn-kol-generate');
  if (btn) btn.disabled = false;
  const sum = $('kol-outline-summary');
  if (sum) {
    sum.textContent = t('kol.outlineReady', {
      n: outline.chapters.length,
      titles: outline.chapters.map((c) => c.index + '. ' + c.title).join('；'),
    });
  }
}

async function onOutline() {
  if (busy) return;
  const spec = specFromForm();
  if (!spec.topic.trim()) { toast(t('kol.needTopic'), true); return; }
  currentSpec = spec;
  setBusy(true, t('kol.outlining'));
  try {
    const outline = await generateOutline(spec);
    renderOutline(outline);
    toast(t('kol.outlineOk'));
  } catch (err) {
    toast(String((err && err.message) || err), true);
  } finally {
    setBusy(false, '');
  }
}

async function onGenerate() {
  if (busy || !currentSpec) return;
  // 用户可能改过大纲：以文本框里的 JSON 为准
  const raw = ($('kol-outline') || {}).value || '';
  const edited = raw.trim() ? parseOutline(raw) : currentOutline;
  if (!edited) { toast(t('kol.outlineInvalid'), true); return; }
  currentOutline = edited;
  const slug = currentSpec.topic ? String(currentSpec.topic) : 'knowledge';
  setBusy(true, t('kol.generating'));
  try {
    // 有联网能力/用户给了 URL 时先收资料；没有就是空数组（模型会标待确认）
    const research = await collectSources({ urls: [], query: currentSpec.topic }).catch(() => ({ sources: [] }));
    const result = await generateKnowledgeBase(currentSpec, currentOutline, {
      sources: research.sources,
      onProgress: (p) => {
        if (p.stage === 'chapter') {
          setBusy(true, t('kol.chapterProgress', { i: p.index, n: p.total, title: p.title }));
        }
      },
    });
    await renderLibraries();
    const lines = [];
    lines.push(t('kol.done', { n: result.files.filter((f) => f.markdown).length, slug: result.slug }));
    if (result.imported) lines.push(t('kol.imported', { n: result.imported }));
    if (result.problems.length) {
      lines.push(t('kol.problems', { n: result.problems.length }));
      for (const p of result.problems.slice(0, 6)) lines.push('· ' + p.code + '：' + p.detail);
    }
    if (result.importErrors.length) lines.push(t('kol.importErrors', { n: result.importErrors.length }));
    lines.push(t('kol.where', { path: 'knowledge/kol/' + slug + '/' }));
    const box = $('kol-progress');
    if (box) box.textContent = lines.join('\n');
    toast(result.ok ? t('kol.publishOk') : t('kol.publishWarn'), !result.ok);
    currentOutline = null;
    if ($('btn-kol-generate')) $('btn-kol-generate').disabled = true;
    // eslint-disable-next-line no-unused-expressions
    slug && renderLibraries();
  } catch (err) {
    toast(String((err && err.message) || err), true);
  } finally {
    setBusy(false, '');
  }
}

/** 已生成的库列表（可刷新 / 删除 / 看差异） */
export async function renderLibraries() {
  const box = $('kol-list');
  if (!box) return;
  let list = [];
  try { list = await listKnowledgeBases(); } catch { list = []; }
  box.innerHTML = '';
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = t('kol.none');
    box.appendChild(p);
    return;
  }
  for (const lib of list) {
    const row = document.createElement('div');
    row.className = 'mem-row';
    const main = document.createElement('span');
    main.className = 'mem-main';
    main.textContent = lib.title + '（' + lib.chapters + ' ' + t('kol.chaptersUnit') + '）';
    const meta = document.createElement('span');
    meta.className = 'mem-meta';
    meta.textContent = lib.updatedAt || '';
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'ghost small-btn';
    refresh.textContent = t('kol.refresh');
    refresh.onclick = async () => {
      refresh.disabled = true;
      try {
        const manifest = await loadManifest(lib.slug);
        if (!manifest) throw new Error(t('kol.noManifest'));
        const spec = Object.assign({ topic: lib.slug, chapters: (manifest.chapters || []).length }, manifest.spec || {});
        const outline = {
          title: manifest.title,
          tags: manifest.tags || [],
          chapters: (manifest.chapters || []).map((c) => ({
            index: c.index, slug: c.slug, title: c.title, goal: c.goal || '', keyPoints: [],
          })),
          glossary: [],
        };
        const res = await refreshKnowledgeBase(lib.slug, spec, outline, {
          onProgress: (p) => {
            if (p.stage === 'chapter') toast(t('kol.chapterProgress', { i: p.index, n: p.total, title: p.title }));
          },
        });
        const diff = res.diff || { changedCount: 0 };
        toast(t('kol.refreshDone', { n: diff.changedCount }));
        await renderLibraries();
      } catch (err) {
        toast(String((err && err.message) || err), true);
      } finally {
        refresh.disabled = false;
      }
    };
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger small-btn';
    del.textContent = t('mem.delete');
    del.onclick = async () => {
      if (typeof confirm === 'function' && !confirm(t('kol.confirmDelete', { name: lib.title }))) return;
      try {
        await deleteKnowledgeBase(lib.slug);
        toast(t('kol.deleted'));
        await renderLibraries();
      } catch (err) {
        toast(String((err && err.message) || err), true);
      }
    };
    row.appendChild(main);
    row.appendChild(meta);
    row.appendChild(refresh);
    row.appendChild(del);
    box.appendChild(row);
  }
}

export function bindKnowledgeGen() {
  const btnA = $('btn-kol-outline');
  if (btnA && !btnA.__aileenBound) {
    btnA.__aileenBound = true;
    btnA.onclick = () => { onOutline(); };
  }
  const btnB = $('btn-kol-generate');
  if (btnB && !btnB.__aileenBound) {
    btnB.__aileenBound = true;
    btnB.onclick = () => { onGenerate(); };
  }
  const refresh = $('btn-kol-refresh');
  if (refresh && !refresh.__aileenBound) {
    refresh.__aileenBound = true;
    refresh.onclick = () => { renderLibraries(); };
  }
  renderLibraries();
}

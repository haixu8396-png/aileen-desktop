// ============================================================
// Persona Studio v2 的界面层
//
// 只做三件事：把结构化人格填进表单、把表单读回结构化人格、刷新 Prompt 预览。
// 编译逻辑全在 persona-v2.js（纯函数、可单测），这里不重复实现一遍。
// ============================================================
import { $, toast } from './dom.js';
import { t, getLang } from './i18n.js';
import {
  SCENES, EMOTION_EXPRESSIONS, normalizePersonaV2, emptyPersonaV2,
  compilePersonaPrompt, isPersonaEmpty,
} from './persona-v2.js';

const TEXT_FIELDS = [
  ['pv-work', 'identity', 'work'],
  ['pv-role', 'identity', 'role'],
  ['pv-world', 'identity', 'world'],
  ['pv-traits', 'personality', 'traits'],
  ['pv-strengths', 'personality', 'strengths'],
  ['pv-flaws', 'personality', 'flaws'],
  ['pv-values', 'personality', 'values'],
  ['pv-temperament', 'personality', 'temperament'],
  ['pv-humor', 'personality', 'humor'],
  ['pv-tone', 'language', 'tone'],
  ['pv-sentencestyle', 'language', 'sentenceStyle'],
  ['pv-vocab', 'language', 'vocabulary'],
  ['pv-formality', 'language', 'formality'],
  ['pv-length', 'language', 'length'],
  ['pv-selfname', 'address', 'selfName'],
  ['pv-userterm', 'address', 'userTerm'],
  ['pv-addrrule', 'address', 'rule'],
  ['pv-story', 'backstory', 'story'],
  ['pv-timeline', 'backstory', 'timeline'],
  ['pv-stage', 'relationships', 'stage'],
  ['pv-boundaries', 'relationships', 'boundaries'],
  ['pv-shared', 'relationships', 'sharedHistory'],
  ['pv-habits', 'habits', null],
  ['pv-initiative', 'interaction', 'initiative'],
  ['pv-style', 'interaction', 'style'],
  ['pv-intboundaries', 'interaction', 'boundaries'],
];

const LIST_KEYS = new Set(['traits', 'strengths', 'flaws', 'values']);

function valueOf(card, group, key) {
  const p = card && card.persona ? card.persona : null;
  if (!p) return '';
  if (group === 'habits') return Array.isArray(p.habits) ? p.habits.join('\n') : '';
  const g = p[group];
  if (!g || typeof g !== 'object') return '';
  const v = g[key];
  if (Array.isArray(v)) return v.join('、');
  return v == null ? '' : String(v);
}

/** 把 card.persona 填进表单 */
export function renderPersonaEditor(card) {
  for (const [id, group, key] of TEXT_FIELDS) {
    const el = $(id);
    if (!el) continue;
    el.value = valueOf(card, group, key);
  }
  renderPhrases(card);
  renderEmotions(card);
  refreshPersonaPreview(card);
}

/** 表单 → card.persona（不写回 card，返回归一化结果） */
export function collectPersonaEditor(card) {
  const persona = emptyPersonaV2();
  for (const [id, group, key] of TEXT_FIELDS) {
    const el = $(id);
    if (!el) continue;
    const raw = String(el.value || '').trim();
    if (group === 'habits') {
      persona.habits = raw ? raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
      continue;
    }
    if (guestGroupMissing(persona, group)) continue;
    if (LIST_KEYS.has(key)) {
      persona[group][key] = raw ? raw.split(/[,，、\n]/).map((s) => s.trim()).filter(Boolean) : [];
    } else {
      persona[group][key] = raw;
    }
  }
  persona.catchphrases = readPhrases(card);
  persona.emotions = readEmotions(card);
  return normalizePersonaV2(persona);
}

function guestGroupMissing(persona, group) {
  return !persona[group] || typeof persona[group] !== 'object';
}

/** 结构化字段全空时不要把 card.persona 写成空壳（否则旧卡被覆盖成空白） */
export function applyCollectedPersona(card) {
  const next = collectPersonaEditor(card);
  if (isPersonaEmpty(next) && !(card.persona && card.persona.catchphrases && card.persona.catchphrases.length)) {
    card.persona = null;
    return card;
  }
  card.persona = next;
  return card;
}

// ---------------- 口头禅表 ----------------

function sceneOptions(selected) {
  const set = new Set((selected || []).map((s) => String(s).toLowerCase()));
  return SCENES.map((s) => '<option value="' + s + '"' + (set.has(s) ? ' selected' : '') + '>' + s + '</option>').join('');
}

export function renderPhrases(card) {
  const box = $('pv-phrases');
  if (!box) return;
  const list = (card && card.persona && Array.isArray(card.persona.catchphrases)) ? card.persona.catchphrases : [];
  box.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = t('pv.noPhrases');
    box.appendChild(empty);
    return;
  }
  list.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'phrase-row';
    row.dataset.idx = String(i);

    const text = document.createElement('input');
    text.className = 'phrase-text';
    text.value = p.text || '';
    text.dataset.i18nPh = 'pv.phrasePh';
    text.placeholder = t('pv.phrasePh');

    const scenes = document.createElement('select');
    scenes.className = 'phrase-scenes';
    scenes.multiple = true;
    scenes.size = 3;
    scenes.innerHTML = sceneOptions(p.scenes);
    scenes.title = t('pv.sceneTip');

    const meta = document.createElement('div');
    meta.className = 'phrase-meta';
    const weight = document.createElement('input');
    weight.type = 'number';
    weight.min = '1';
    weight.max = '10';
    weight.value = String(p.weight || 1);
    weight.title = t('pv.weight');

    const cd = document.createElement('input');
    cd.type = 'number';
    cd.min = '0';
    cd.max = '100';
    cd.value = String(p.cooldownTurns || 0);
    cd.title = t('pv.cooldownTurns');

    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = p.enabled !== false;
    enabled.title = t('pv.enabled');

    meta.appendChild(weight);
    meta.appendChild(cd);
    meta.appendChild(enabled);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ghost small-btn';
    del.textContent = '×';
    del.title = t('pv.remove');
    del.onclick = () => {
      list.splice(i, 1);
      renderPhrases(card);
    };

    row.appendChild(text);
    row.appendChild(scenes);
    row.appendChild(meta);
    row.appendChild(del);
    box.appendChild(row);
  });
}

function readPhrases(card) {
  const out = [];
  const box = $('pv-phrases');
  if (!box || !card) return out;
  const rows = Array.from(box.querySelectorAll('.phrase-row'));
  rows.forEach((row, i) => {
    const text = (row.querySelector('.phrase-text') || {}).value || '';
    const sel = row.querySelector('.phrase-scenes');
    const scenes = sel ? Array.from(sel.selectedOptions || []).map((o) => o.value) : [];
    const nums = Array.from(row.querySelectorAll('.phrase-meta input[type="number"]'));
    const enabled = (row.querySelector('.phrase-meta input[type="checkbox"]') || {}).checked !== false;
    if (!String(text).trim()) return;
    out.push({
      id: 'cp-' + (i + 1),
      text: String(text).trim(),
      scenes,
      emotions: [],
      weight: Number(nums[0] && nums[0].value) || 1,
      cooldownTurns: Number(nums[1] && nums[1].value) || 0,
      cooldownSeconds: 0,
      enabled,
      priority: 0,
    });
  });
  return out;
}

export function addPhrase() {
  const editor = $('pv-phrases');
  if (!editor) return;
  // 直接往编辑器里加一行空行（真正的数据在保存时从 DOM 读）
  const card = { persona: { catchphrases: [] } };
  const rows = editor.querySelectorAll('.phrase-row');
  rows.forEach((row) => {
    const text = (row.querySelector('.phrase-text') || {}).value || '';
    if (!String(text).trim()) return;
    const sel = row.querySelector('.phrase-scenes');
    const scenes = sel ? Array.from(sel.selectedOptions || []).map((o) => o.value) : [];
    const nums = Array.from(row.querySelectorAll('.phrase-meta input[type="number"]'));
    const enabled = (row.querySelector('.phrase-meta input[type="checkbox"]') || {}).checked !== false;
    card.persona.catchphrases.push({
      text,
      scenes,
      weight: Number(nums[0] && nums[0].value) || 1,
      cooldownTurns: Number(nums[1] && nums[1].value) || 0,
      enabled,
    });
  });
  card.persona.catchphrases.push({ text: t('pv.newPhrase'), scenes: ['normal'], weight: 1, cooldownTurns: 3, enabled: true });
  // 用一个临时对象渲染（值已经全部读出来了，不会丢）
  renderPhrases(card);
}

// ---------------- 情绪表 ----------------

export function renderEmotions(card) {
  const box = $('pv-emotions');
  if (!box) return;
  const list = (card && card.persona && Array.isArray(card.persona.emotions)) ? card.persona.emotions : [];
  box.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = t('pv.noEmotions');
    box.appendChild(empty);
    return;
  }
  list.forEach((e, i) => {
    const row = document.createElement('div');
    row.className = 'emotion-row';
    const emotion = document.createElement('input');
    emotion.className = 'emotion-name';
    emotion.value = e.emotion || '';
    emotion.placeholder = t('pv.emotionPh');
    const triggers = document.createElement('input');
    triggers.className = 'emotion-triggers';
    triggers.value = e.triggers || '';
    triggers.placeholder = t('pv.triggersPh');
    const expr = document.createElement('input');
    expr.className = 'emotion-expr';
    expr.value = e.expression || '';
    expr.placeholder = t('pv.exprPh');
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ghost small-btn';
    del.textContent = '×';
    del.onclick = () => {
      list.splice(i, 1);
      renderEmotions(card);
    };
    row.appendChild(emotion);
    row.appendChild(triggers);
    row.appendChild(expr);
    row.appendChild(del);
    box.appendChild(row);
  });
}

function readEmotions(card) {
  const out = [];
  const box = $('pv-emotions');
  if (!box || !card) return out;
  box.querySelectorAll('.emotion-row').forEach((row) => {
    const emotion = String((row.querySelector('.emotion-name') || {}).value || '').trim();
    if (!emotion) return;
    out.push({
      emotion: emotion.toLowerCase(),
      triggers: String((row.querySelector('.emotion-triggers') || {}).value || '').trim(),
      expression: String((row.querySelector('.emotion-expr') || {}).value || '').trim(),
    });
  });
  return out;
}

export function addEmotion() {
  const box = $('pv-emotions');
  if (!box) return;
  const card = { persona: { emotions: readEmotions({}) } };
  // 用当前表单内容重画 + 追加一行空的
  const list = [];
  box.querySelectorAll('.emotion-row').forEach((row) => {
    const emotion = String((row.querySelector('.emotion-name') || {}).value || '').trim();
    if (emotion) {
      list.push({
        emotion,
        triggers: String((row.querySelector('.emotion-triggers') || {}).value || '').trim(),
        expression: String((row.querySelector('.emotion-expr') || {}).value || '').trim(),
      });
    }
  });
  list.push({ emotion: '', triggers: '', expression: '' });
  card.persona.emotions = list;
  renderEmotions(card);
}

// ---------------- Prompt 预览 ----------------

export function refreshPersonaPreview(card) {
  const box = $('pv-prompt');
  if (!box) return '';
  const src = card || { persona: collectPersonaEditor({}) };
  const text = compilePersonaPrompt(src.persona, { lang: getLang() });
  box.value = text || t('pv.promptEmpty');
  return text;
}

export function bindPersonaEditor() {
  const addPhraseBtn = $('pv-add-phrase');
  if (addPhraseBtn && !addPhraseBtn.__aileenBound) {
    addPhraseBtn.__aileenBound = true;
    addPhraseBtn.onclick = () => addPhrase();
  }
  const addEmotionBtn = $('pv-add-emotion');
  if (addEmotionBtn && !addEmotionBtn.__aileenBound) {
    addEmotionBtn.__aileenBound = true;
    addEmotionBtn.onclick = () => addEmotion();
  }
  const refresh = $('pv-prompt-refresh');
  if (refresh && !refresh.__aileenBound) {
    refresh.__aileenBound = true;
    refresh.onclick = () => {
      const text = refreshPersonaPreview();
      toast(text ? t('pv.promptOk') : t('pv.promptEmptyToast'));
    };
  }
  // 情绪映射的提示：默认情绪 → 表情关键词
  const hint = $('pv-emotion-hint');
  if (hint) {
    const parts = Object.keys(EMOTION_EXPRESSIONS).map((k) => k + ' → ' + EMOTION_EXPRESSIONS[k].join('/'));
    hint.textContent = t('pv.emotionHint') + ' ' + parts.join('；');
  }
}

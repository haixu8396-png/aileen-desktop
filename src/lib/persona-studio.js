// ============================================================
// 人设生成室（设置 → 人设生成）
//
// 和角色编辑器里那颗「生成」按钮的区别：这里**先选原型、再锁定**。
// 只给一句灵感时，模型很容易写成通用助手（也就是「乱写」）；
// 把原型「怎么演」锁死后，出来的人才稳定属于你要的那一类。
//
// 生成结果不在这里保存 —— 直接填进角色编辑器，让人自己看着改、自己按保存。
// 生成的是草稿，不是成品。
// ============================================================
import { t, getLang } from './i18n.js';
import { PERSONALITIES, ROLES, GENDERS, RELATIONSHIPS, labelOf } from './archetypes.js';
import { generatePersonaDraft, regeneratePersonaField } from './persona.js';
import { getSettings, hasApiKey } from './settings.js';
import { $, toast } from './dom.js';
import { hooks, state } from './state.js';
import { openCharModal, applyPersonaToEditor } from './characters-ui.js';
import { renderPersonaEditor } from './persona-ui.js';
import { iconSvg } from './icons.js';

const sel = { mode: 'original', personalityId: '', roleId: '', genderId: 'any', relationId: 'any' };

/** 当前草稿（什么都没应用；用户点了「应用到编辑器」才进卡） */
let studioDraft = null;

/** 原创 / 已有角色两个模式切换：各自只显示自己需要的字段，不摆一堆用不上的东西 */
export function setStudioMode(mode) {
  sel.mode = mode === 'known' ? 'known' : 'original';
  const known = $('pa-known-block');
  const original = $('pa-original-block');
  if (known) known.classList.toggle('hidden', sel.mode !== 'known');
  if (original) original.classList.toggle('hidden', sel.mode !== 'original');
  const r1 = $('pa-mode-original');
  const r2 = $('pa-mode-known');
  if (r1) r1.checked = sel.mode === 'original';
  if (r2) r2.checked = sel.mode === 'known';
  const char = $('pa-char');
  if (char) char.focus();
}

// 原型卡前面那颗圆形徽章：取本地化名字的第一个字。
// 用单字徽章而不是 Emoji —— 三种语言下都成立（「傲」「ツ」「T」），
// 也不再为 30 个原型维护 30 个风格不一的图形。
function monogram(text) {
  const s = String(text || '').trim();
  return s ? s.slice(0, 1).toUpperCase() : '·';
}

function chipEntries(list) {
  const lang = getLang();
  return [{ id: '', icon: '·', text: t('studio.none') }]
    .concat(list.map((x) => {
      const text = labelOf(x, lang);
      return { id: x.id, icon: monogram(text), text };
    }));
}

function renderChips(box, list, current, onPick) {
  if (!box) return;
  box.innerHTML = '';
  for (const e of chipEntries(list)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'arch-chip' + (e.id === current ? ' on' : '');
    b.dataset.archId = e.id;   // 自检/测试要用它选中某个原型
    const ic = document.createElement('span');
    ic.className = 'arch-icon';
    ic.textContent = e.icon;
    const lb = document.createElement('span');
    lb.textContent = e.text;
    b.appendChild(ic);
    b.appendChild(lb);
    b.onclick = () => { onPick(e.id); };
    box.appendChild(b);
  }
}

function fillSelect(box, list, current) {
  if (!box) return;
  const lang = getLang();
  box.innerHTML = '';
  for (const x of list) {
    const o = document.createElement('option');
    o.value = x.id;
    o.textContent = labelOf(x, lang);
    box.appendChild(o);
  }
  box.value = current;
}

function renderGender() {
  fillSelect($('pa-gender'), GENDERS, sel.genderId);
}

function renderRelation() {
  fillSelect($('pa-rel'), RELATIONSHIPS, sel.relationId);
}

function renderAll() {
  renderChips($('pa-personalities'), PERSONALITIES, sel.personalityId, (id) => {
    sel.personalityId = id;
    renderAll();
  });
  renderChips($('pa-roles'), ROLES, sel.roleId, (id) => {
    sel.roleId = id;
    renderAll();
  });
  renderGender();
  renderRelation();
  setStudioMode(sel.mode);
}

export function openPersonaStudio() {
  // 人设生成室现在住在「角色编辑页」里：先确保编辑页是打开的
  const page = $('page-char-edit');
  if (!page || !page.classList.contains('on')) {
    const cur = state.current;
    openCharModal(cur ? cur.data : null, cur ? cur.file : null);
  }
  const wrap = $('persona-wrap');
  if (wrap) wrap.open = true;
  renderAll();
  const m = $('modal-persona');
  if (m) m.classList.remove('hidden');
  const mEl = $('modal-persona');
  if (mEl && typeof mEl.scrollIntoView === 'function') mEl.scrollIntoView({ block: 'nearest' });
}

export function closePersonaStudio() {
  const m = $('modal-persona');
  if (m) m.classList.add('hidden');
  const wrap = $('persona-wrap');
  if (wrap) wrap.open = false;
}

/** 表单 → 生成选项。导出是为了让自检能验证「界面上选的东西真的进了提示词」。 */
export function studioFormOptions() {
  return {
    mode: sel.mode,
    charName: ($('pa-char') || {}).value || '',
    work: ($('pa-work') || {}).value || '',
    version: ($('pa-version') || {}).value || '',
    fidelity: ($('pa-fidelity') || {}).value || 'strict',
    relationId: ($('pa-rel') || {}).value || 'any',
    userName: ($('pa-user') || {}).value || '',
    seed: ($('pa-seed') || {}).value || '',
    personalityId: sel.personalityId,
    roleId: sel.roleId,
    lockPersonality: !!($('pa-lock-p') || {}).checked,
    lockRole: !!($('pa-lock-r') || {}).checked,
    name: ($('pa-name') || {}).value || '',
    genderId: ($('pa-gender') || {}).value || 'any',
    age: ($('pa-age') || {}).value || '',
    extra: ($('pa-extra') || {}).value || '',
  };
}

/** 草稿面板：把「来源 / 事实分级 / 版权自检」摊给用户看，而不是直接写卡 */
function renderDraftPanel() {
  const box = $('pa-draft');
  if (!box) return;
  if (!studioDraft) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const d = studioDraft;
  const status = $('pa-draft-status');
  if (status) {
    status.textContent = d.status === 'draft' ? t('studio.draftStatus') : '';
  }
  const meta = $('pa-draft-meta');
  if (meta) {
    const c = d.confidence || {};
    const bits = [];
    if (d.sourceCharacter && d.sourceCharacter.name) bits.push(d.sourceCharacter.name);
    if (d.sourceCharacter && d.sourceCharacter.work) bits.push(d.sourceCharacter.work);
    bits.push(t('studio.draftFacts', {
      confirmed: (c.confirmedFacts || []).length,
      secondary: (c.secondaryClaims || []).length,
      inferred: (c.inferences || []).length,
      unknown: (c.unknowns || []).length,
    }));
    meta.textContent = bits.join(' · ');
  }
  const srcBox = $('pa-draft-sources');
  if (srcBox) {
    const list = (d.sourceCharacter && d.sourceCharacter.sources) || [];
    srcBox.textContent = list.length
      ? t('studio.draftSources', { n: list.length }) + ' ' + list.map((s) => s.title || s.url).filter(Boolean).join('；')
      : t('studio.draftNoSources');
  }
  const warn = $('pa-draft-warn');
  if (warn) {
    const reasons = (d.copyright && d.copyright.reasons) || [];
    warn.textContent = reasons.length ? t('studio.draftCopyright') + ' ' + reasons.join('；') : '';
  }
}

/** 把草稿里某个字段的当前值取出来（给「重生成这个字段」做上下文） */
function draftFieldValue(field) {
  const d = studioDraft;
  if (!d) return '';
  const legacyKeys = ['description', 'scenario', 'first_mes', 'mes_example'];
  if (legacyKeys.includes(field)) return String((d.legacy || {})[field] || '');
  const parts = String(field).split('.');
  if (parts.length === 2) {
    const g = (d.persona || {})[parts[0]];
    const v = g && g[parts[1]];
    return Array.isArray(v) ? v.join('、') : String(v || '');
  }
  return '';
}

function draftSetField(field, value) {
  const d = studioDraft;
  if (!d) return;
  const legacyKeys = ['description', 'scenario', 'first_mes', 'mes_example'];
  if (legacyKeys.includes(field)) {
    d.legacy = Object.assign({}, d.legacy, { [field]: value });
    return;
  }
  const parts = String(field).split('.');
  if (parts.length === 2) {
    const group = Object.assign({}, d.persona && d.persona[parts[0]]);
    group[parts[1]] = parts[1] === 'traits' ? String(value).split(/[、,，]/).map((s) => s.trim()).filter(Boolean) : value;
    d.persona = Object.assign({}, d.persona, { [parts[0]]: group });
  }
}

async function regenerateDraftField() {
  const fieldSel = $('pa-regen-field');
  const field = fieldSel ? fieldSel.value : 'description';
  const btn = $('pa-regen');
  if (btn) btn.disabled = true;
  try {
    const value = await regeneratePersonaField(getSettings(), {
      field,
      options: studioFormOptions(),
      current: draftFieldValue(field),
    });
    draftSetField(field, value);
    renderDraftPanel();
    toast(t('studio.regenOk'));
  } catch (err) {
    toast(String((err && err.message) || err), true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** 应用草稿：先开一张空白卡，再写进去 —— 用户仍然要自己按保存 */
function applyDraft() {
  const d = studioDraft;
  if (!d) return;
  const legacy = d.legacy || {};
  closePersonaStudio();
  openCharModal(null, null);
  applyPersonaToEditor({
    name: (d.sourceCharacter && d.sourceCharacter.name) || '',
    description: legacy.description || '',
    personality: '',
    scenario: legacy.scenario || '',
    first_mes: legacy.first_mes || '',
    mes_example: legacy.mes_example || '',
  });
  if (state.editorCard) {
    state.editorCard.persona = d.persona;
    state.editorCard.spec = 'aileen-card-v2';
    renderPersonaEditor(state.editorCard);
  }
  studioDraft = null;
  renderDraftPanel();
  toast(t('studio.draftApplied'));
}

export async function generateFromStudio() {
  const s = getSettings();
  if (!hasApiKey('llm')) {
    toast(t('char.genNeedKey'));
    if (hooks.openLlmModal) hooks.openLlmModal();
    return;
  }
  const btn = $('pa-generate');
  const label = btn ? btn.textContent : '';
  const setLabel = (text) => {
    if (!btn) return;
    btn.innerHTML = iconSvg('spark', 16) + '<span>' + String(text).replace(/[<>&]/g, '') + '</span>';
  };
  if (btn) { btn.disabled = true; setLabel(t('studio.busy')); }
  try {
    // 联网资料：0.7.9 里由 R6 的能力探针决定能不能拿到；
    // 拿不到就传空数组，模型会在 unknowns 里如实标注（不编造）。
    const sources = [];
    const draft = await generatePersonaDraft(s, studioFormOptions(), { sources });
    studioDraft = draft;
    renderDraftPanel();
    toast(t('studio.draftReady'));
  } catch (err) {
    toast(String((err && err.message) || err), true);
  } finally {
    if (btn) { btn.disabled = false; setLabel(label || t('studio.generate')); }
  }
}

export function bindPersonaStudio() {
  // 角色编辑页里的「人设生成室」是个 <details>：展开它就应该看到内容。
  // 以前内容块带着 hidden，真正的展开要靠 openPersonaStudio()，而那个入口界面上没有 ——
  // 用户看到的就是「点开人设生成室什么都没有」（= 功能不见了）。
  const wrap = $('persona-wrap');
  if (wrap && !wrap.__aileenBound) {
    wrap.__aileenBound = true;
    wrap.addEventListener('toggle', () => {
      if (wrap.open) openPersonaStudio();
    });
  }
  const cancel = $('pa-cancel');
  if (cancel) cancel.onclick = () => closePersonaStudio();
  const gen = $('pa-generate');
  if (gen) gen.onclick = () => { generateFromStudio(); };
  if ($('pa-draft-apply')) $('pa-draft-apply').onclick = () => applyDraft();
  if ($('pa-draft-discard')) {
    $('pa-draft-discard').onclick = () => {
      studioDraft = null;
      renderDraftPanel();
      toast(t('studio.draftDiscarded'));
    };
  }
  if ($('pa-regen')) $('pa-regen').onclick = () => { regenerateDraftField(); };
  const seed = $('pa-seed');
  if (seed) seed.addEventListener('keydown', (e) => { if (e.key === 'Enter') generateFromStudio(); });
  const char = $('pa-char');
  if (char) char.addEventListener('keydown', (e) => { if (e.key === 'Enter') generateFromStudio(); });
  const r1 = $('pa-mode-original');
  if (r1) r1.onchange = () => setStudioMode('original');
  const r2 = $('pa-mode-known');
  if (r2) r2.onchange = () => setStudioMode('known');
  const rel = $('pa-rel');
  if (rel) rel.onchange = () => { sel.relationId = rel.value; };
  const gender = $('pa-gender');
  if (gender) gender.onchange = () => { sel.genderId = gender.value; };
}

// 自检钩子：验证「锁定」确实改变了发给模型的提示词（而不只是界面上有个勾）
export const __studioState = sel;

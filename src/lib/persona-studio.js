// ============================================================
// 人设生成室（设置 → ✨ 人设生成）
//
// 和角色编辑器里那颗「✨ 生成」的区别：这里**先选原型、再锁定**。
// 只给一句灵感时，模型很容易写成通用助手（也就是「乱写」）；
// 把原型「怎么演」锁死后，出来的人才稳定属于你要的那一类。
//
// 生成结果不在这里保存 —— 直接填进角色编辑器，让人自己看着改、自己按保存。
// 生成的是草稿，不是成品。
// ============================================================
import { t, getLang } from './i18n.js';
import { PERSONALITIES, ROLES, GENDERS, RELATIONSHIPS, labelOf } from './archetypes.js';
import { generatePersonaCard } from './persona.js';
import { getSettings, hasApiKey } from './settings.js';
import { $, toast } from './dom.js';
import { hooks } from './state.js';
import { openCharModal, applyPersonaToEditor } from './characters-ui.js';

const sel = { mode: 'original', personalityId: '', roleId: '', genderId: 'any', relationId: 'any' };

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

function chipEntries(list) {
  const lang = getLang();
  return [{ id: '', icon: '·', text: t('studio.none') }]
    .concat(list.map((x) => ({ id: x.id, icon: x.icon, text: labelOf(x, lang) })));
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
  renderAll();
  const m = $('modal-persona');
  if (m) m.classList.remove('hidden');
}

export function closePersonaStudio() {
  const m = $('modal-persona');
  if (m) m.classList.add('hidden');
}

/** 表单 → 生成选项。导出是为了让自检能验证「界面上选的东西真的进了提示词」。 */
export function studioFormOptions() {
  return {
    mode: sel.mode,
    charName: ($('pa-char') || {}).value || '',
    work: ($('pa-work') || {}).value || '',
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

export async function generateFromStudio() {
  const s = getSettings();
  if (!hasApiKey('llm')) {
    toast(t('char.genNeedKey'));
    if (hooks.openLlmModal) hooks.openLlmModal();
    return;
  }
  const btn = $('pa-generate');
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = t('studio.busy'); }
  try {
    // 额度和重试策略都在 generatePersonaCard 里（和编辑器那颗生成按钮完全同一套）
    const p = await generatePersonaCard(s, studioFormOptions());
    // 先开一张空白卡，再把结果填进去 —— 后面的「改、存」都走已有的编辑器逻辑
    closePersonaStudio();
    openCharModal(null, null);
    applyPersonaToEditor(p);
    toast(t('char.genOk'));
  } catch (err) {
    toast(String((err && err.message) || err), true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label || t('studio.generate'); }
  }
}

export function bindPersonaStudio() {
  const cancel = $('pa-cancel');
  if (cancel) cancel.onclick = () => closePersonaStudio();
  const gen = $('pa-generate');
  if (gen) gen.onclick = () => { generateFromStudio(); };
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

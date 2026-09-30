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
import { PERSONALITIES, ROLES, GENDERS, labelOf } from './archetypes.js';
import { generatePersonaCard } from './persona.js';
import { getSettings } from './settings.js';
import { $, toast } from './dom.js';
import { hooks } from './state.js';
import { openCharModal, applyPersonaToEditor } from './characters-ui.js';

const sel = { personalityId: '', roleId: '', genderId: 'any' };

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

function renderGender() {
  const box = $('pa-gender');
  if (!box) return;
  const lang = getLang();
  box.innerHTML = '';
  for (const g of GENDERS) {
    const o = document.createElement('option');
    o.value = g.id;
    o.textContent = labelOf(g, lang);
    box.appendChild(o);
  }
  box.value = sel.genderId;
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

function formOptions() {
  return {
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
  if (!s || !s.llm || !s.llm.apiKey) {
    toast(t('char.genNeedKey'));
    if (hooks.openLlmModal) hooks.openLlmModal();
    return;
  }
  const btn = $('pa-generate');
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = t('studio.busy'); }
  try {
    // 额度和重试策略都在 generatePersonaCard 里（和编辑器那颗生成按钮完全同一套）
    const p = await generatePersonaCard(s, formOptions());
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
}

// 自检钩子：验证「锁定」确实改变了发给模型的提示词（而不只是界面上有个勾）
export const __studioState = sel;

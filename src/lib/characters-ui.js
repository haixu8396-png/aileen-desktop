// ============================================================
// 角色卡 UI 控制器：列表、右键/更多菜单、编辑器、快捷更换模型语音
// ============================================================
import { getSettings, deepMerge, hasApiKey } from './settings.js';
import { emptyCard, cardFileName } from './characters.js';
import { escapeHtml } from './markdown.js';
import { state, hooks, tts } from './state.js';
import { $, toast, scrollBottom, avatarUrl } from './dom.js';
import { renderMessages, saveChatFor, loadChatFor, clearChatFor, ttsSettingsForCharacter, setBusy } from './chat.js';
import { setStageModelIndex, updateStageModelName, syncOverlayModel } from './stage.js';
import { t } from './i18n.js';
import { generatePersonaCard } from './persona.js';
import { broadcastSession } from './session-coordinator.js';
import { iconSvg, applyIcons } from './icons.js';
import { currentPage, fillAvatar, gotoPage } from './shell.js';
import { renderCharactersPage } from './pages.js';

export function findChar(file) {
  return state.characters.find((c) => c.file === file);
}

// ---------------- 角色列表 ----------------
let charFilter = '';

/** 侧栏搜索框 */
export function setCharFilter(q) {
  charFilter = String(q || '').trim().toLowerCase();
  renderCharList();
}

function matchesFilter(c) {
  if (!charFilter) return true;
  const hay = ((c.data.name || '') + ' ' + (c.data.description || '') + ' ' + (c.data.personality || '') + ' ' + c.file).toLowerCase();
  return hay.indexOf(charFilter) >= 0;
}

export function renderCharList() {
  const box = $('char-list');
  if (!box) return;
  box.innerHTML = '';
  if (!state.characters.length) {
    box.innerHTML = '<div class="ci-empty">' + t('nav.noChars') + '</div>';
    return;
  }
  // 侧栏只放最近用的 6 个：完整角色库在「角色」页，这里保持导航安静
  const all = state.characters.filter(matchesFilter);
  const recent = all.slice(0, 6);
  for (const c of recent) {
    const item = document.createElement('div');
    item.className = 'char-item' + (state.current && state.current.file === c.file ? ' active' : '');
    item.dataset.file = c.file;
    const img = document.createElement('span');
    img.className = 'avatar';
    img.alt = '';
    fillAvatar(img, c.data.name || c.file, avatarUrl(c.data.avatar));
    const meta = document.createElement('div');
    meta.style.cssText = 'min-width:0;flex:1';
    const nm = document.createElement('div');
    nm.className = 'ci-name';
    nm.textContent = c.data.name || c.file;
    meta.appendChild(nm);
    // 绑定徽章：一眼看出这张卡有没有配模型 / 音色
    const badges = document.createElement('div');
    badges.className = 'ci-badges';
    if (c.data.model) {
      const b = document.createElement('span');
      b.className = 'ci-badge';
      b.innerHTML = iconSvg('layers', 12);
      b.title = t('char.model') + ': ' + c.data.model;
      badges.appendChild(b);
    }
    if (c.data.voice) {
      const b = document.createElement('span');
      b.className = 'ci-badge voice';
      b.innerHTML = iconSvg('speaker', 12);
      b.title = t('char.voice') + ': ' + c.data.voice;
      badges.appendChild(b);
    }
    if (badges.children.length) meta.appendChild(badges);

    const more = document.createElement('button');
    more.className = 'ci-more';
    more.innerHTML = iconSvg('more', 14);
    more.title = t('chat.menuTitle');
    more.onclick = (e) => { e.stopPropagation(); openCharMenuAt(c.file, e.clientX, e.clientY); };
    item.appendChild(img); item.appendChild(meta); item.appendChild(more);
    item.onclick = async () => { await selectCharacter(c.file, { greet: true }); gotoPage('chat'); };
    item.ondblclick = () => openCharModal(c.data, c.file);
    item.oncontextmenu = (e) => { e.preventDefault(); openCharMenuAt(c.file, e.clientX, e.clientY); };
    box.appendChild(item);
  }
}

export function renderEmptyState() {
  const box = $('messages');
  if (!box) return;
  if (state.characters.length > 0) return;
  fillAvatar($('chat-avatar'), 'AILEEN', '');
  $('chat-name').textContent = 'AILEEN';
  $('chat-desc').textContent = t('chat.emptyDesc');
  // 空状态：品牌标识 + 一句引导，安静居中（不用一个假的气泡冒充对话）
  box.innerHTML = '<div class="empty-state">'
    + '<span class="empty-mark" aria-hidden="true">' + iconSvg('mark', 40) + '</span>'
    + '<p class="empty-title">' + escapeHtml(t('chat.emptyTitle')) + '</p>'
    + '<p class="empty-desc">' + escapeHtml(t('chat.emptyDesc')) + '</p>'
    + '<div class="empty-actions"><button id="empty-new-card" class="primary">'
    + '<span data-icon="plus"></span>' + escapeHtml(t('nav.newChar')) + '</button></div>'
    + '</div>';
  const btn = $('empty-new-card');
  if (btn) btn.onclick = () => openCharModal(null, null);
  applyIcons(box);
  scrollBottom();
  broadcastSession('messages');
}

export function updateChatHeader() {
  if (!state.current) { renderEmptyState(); return; }
  fillAvatar($('chat-avatar'), state.current.data.name || state.current.file, avatarUrl(state.current.data.avatar));
  $('chat-name').textContent = state.current.data.name || state.current.file;
  $('chat-desc').textContent = state.current.data.description || t('chat.noCharacterHint');
}

export async function selectCharacter(file, opts = {}) {
  const found = findChar(file);
  if (!found) return;
  if (state.current && state.current.file !== file) {
    await saveChatFor(state.current.file);
    tts.cancel();
    if (state.abortCtrl) state.abortCtrl.abort();
    if (state.busy) setBusy(false);
  }
  state.current = found;
  localStorage.setItem('aileen.currentChar', file);
  renderCharList();
  updateChatHeader();
  // 双窗口：角色切换要同步给展台（同一套角色数据，不各维护一份）
  try { broadcastSession('character'); } catch (err) { /* 展台没开就算了 */ }

  // 绑定 Live2D 模型（主窗口不再渲染，模型推给独立展台）
  if (found.data.model) {
    const idx = state.models.findIndex((m) => m.file === found.data.model);
    if (idx >= 0) setStageModelIndex(idx);
    updateStageModelName();
  }
  syncOverlayModel();

  const saved = await loadChatFor(file);
  if (saved && saved.length) {
    state.messages = saved;
    state.lastAssistantText = (saved.slice().reverse().find((m) => m.role === 'assistant') || {}).content || '';
    renderMessages();
  } else if (opts.greet && found.data.first_mes && getSettings().behavior.greetingOnLoad) {
    state.messages = [];
    state.messages.push({ role: 'assistant', content: found.data.first_mes });
    renderMessages();
    state.lastAssistantText = found.data.first_mes;
    saveChatFor(file);
    if (getSettings().tts.autoPlay) tts.enqueue(found.data.first_mes, ttsSettingsForCharacter());
  } else {
    state.messages = [];
    renderMessages();
  }
}

export async function refreshCharacters(preferFile) {
  state.characters = await window.api.listCharacters();
  renderCharList();
  if (preferFile) await selectCharacter(preferFile, { greet: false });
  else if (!state.current && state.characters.length) await selectCharacter(state.characters[0].file, { greet: true });
}

// ---------------- 角色卡菜单 ----------------
export function openCharMenuAt(file, x, y) {
  state.currentMenuFile = file;
  const menu = $('char-menu');
  menu.classList.remove('hidden');
  menu.style.left = '0px';
  menu.style.top = '0px';
  const r = menu.getBoundingClientRect();
  // 贴边弹出时不能越出窗口；窗口极窄时也不能算出负坐标
  const left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

export function closeCharMenu() {
  $('char-menu').classList.add('hidden');
  state.currentMenuFile = null;
}

export async function duplicateCard(file) {
  const c = findChar(file);
  if (!c) return;
  const copy = JSON.parse(JSON.stringify(c.data));
  copy.name = (copy.name || 'AILEEN') + ' (copy)';
  copy.createdAt = Date.now();
  copy.updatedAt = Date.now();
  const res = await window.api.writeCharacter(cardFileName(copy), copy, 'create');
  if (res) {
    await refreshCharacters(res.file);
    toast(t('char.duplicated', { name: copy.name }));
  }
}

export async function deleteCard(file) {
  const c = findChar(file);
  if (!c) return;
  if (!confirm(t('char.confirmDelete', { name: c.data.name || file }))) return;
  await window.api.deleteCharacter(file);
  if (state.current && state.current.file === file) {
    state.current = null;
    state.messages = [];
    await clearChatFor(file);
  }
  await refreshCharacters();
  toast(t('char.deleted'));
}

// ---------------- 快捷更换模型 / 语音 ----------------
export function populateQuickSelects() {
  const qm = $('q-model');
  qm.innerHTML = '<option value="">' + t('char.unbound') + '</option>' +
    state.models.map((m) => '<option value="' + escapeHtml(m.file) + '">' + escapeHtml(m.name) + '</option>').join('');
  const qv = $('q-voice');
  qv.innerHTML = '<option value="">' + t('char.defaultVoice') + '</option>';
  let voices = [];
  try { voices = window.speechSynthesis.getVoices(); } catch { /* ignore */ }
  qv.innerHTML += voices.map((v) => '<option value="' + escapeHtml(v.name) + '">' + escapeHtml(v.name + ' · ' + v.lang) + '</option>').join('');
}

export function openQuickModal(file) {
  const c = findChar(file);
  if (!c) return;
  state.quickFile = file;
  populateQuickSelects();
  $('q-model').value = c.data.model || '';
  $('q-voice').value = c.data.voice || '';
  $('quick-title').textContent = t('quick.title') + ' · ' + (c.data.name || file);
  $('modal-quick').classList.remove('hidden');
}

export async function saveQuickModal() {
  if (!state.quickFile) return;
  const c = findChar(state.quickFile);
  if (!c) return;
  const data = { ...c.data, model: $('q-model').value, voice: $('q-voice').value, updatedAt: Date.now() };
  await window.api.writeCharacter(state.quickFile.replace(/\.json$/, ''), data, 'update');
  state.characters = await window.api.listCharacters();
  renderCharList();
  $('modal-quick').classList.add('hidden');
  if (state.current && state.current.file === state.quickFile) await selectCharacter(state.quickFile, { greet: false });
  toast(t('char.quickUpdated'));
}

// ---------------- 角色编辑器 ----------------
export function populateModelSelect(select) {
  const el = select || $('f-model');
  el.innerHTML = '<option value="">' + t('char.unbound') + '</option>' +
    state.models.map((m) => '<option value="' + escapeHtml(m.file) + '">' + escapeHtml(m.name) + '</option>').join('');
}

export function populateVoiceSelect() {
  const el = $('f-voice');
  el.innerHTML = '<option value="">' + t('char.defaultVoice') + '</option>';
  let voices = [];
  try { voices = window.speechSynthesis.getVoices(); } catch { /* ignore */ }
  if (!voices.length) return;
  voices = voices.slice().sort((a, b) => (a.lang < b.lang ? -1 : 1));
  el.innerHTML += voices.map((v) => '<option value="' + escapeHtml(v.name) + '">' + escapeHtml(v.name + ' · ' + v.lang) + '</option>').join('');
}

export function openCharModal(card, file) {
  state.editorReturnPage = currentPage();
  state.editorCard = card ? deepMerge(emptyCard(), card) : emptyCard();
  state.editorFile = file || null;
  $('char-modal-title').textContent = state.editorFile ? t('char.edit', { name: state.editorCard.name }) : t('char.new');
  $('f-name').value = state.editorCard.name || '';
  $('f-desc').value = state.editorCard.description || '';
  $('f-personality').value = state.editorCard.personality || '';
  $('f-scenario').value = state.editorCard.scenario || '';
  $('f-first').value = state.editorCard.first_mes || '';
  $('f-example').value = state.editorCard.mes_example || '';
  $('f-system').value = state.editorCard.system_prompt || '';
  populateModelSelect();
  populateVoiceSelect();
  $('f-model').value = state.editorCard.model || '';
  $('f-voice').value = state.editorCard.voice || '';
  fillAvatar($('f-avatar-preview'), state.editorCard.name || 'A', avatarUrl(state.editorCard.avatar));
  fillAvatar($('f-avatar-preview-2'), state.editorCard.name || 'A', avatarUrl(state.editorCard.avatar));
  const n = $('f-preview-name');
  const d = $('f-preview-desc');
  const m = $('f-preview-model');
  const v = $('f-preview-voice');
  if (n) n.textContent = state.editorCard.name || t('char.previewName');
  if (d) d.textContent = state.editorCard.description || t('char.previewDesc');
  if (m) m.textContent = state.editorCard.model || t('char.noModel');
  if (v) v.textContent = state.editorCard.voice || t('char.noVoice');
  $('f-delete').classList.toggle('hidden', !state.editorFile);
  // 人设生成室默认收起：它是编辑页里的可选工具，不抢正文
  const wrap = $('persona-wrap');
  if (wrap) wrap.open = false;
  const persona = $('modal-persona');
  if (persona) persona.classList.add('hidden');
  gotoPage('char-edit');
}

// ---------------- 自动生成人设 ----------------

export function applyPersonaToEditor(p) {
  if (!state.editorCard) state.editorCard = emptyCard();
  const pairs = [
    ['name', 'f-name'], ['description', 'f-desc'], ['personality', 'f-personality'],
    ['scenario', 'f-scenario'], ['first_mes', 'f-first'], ['mes_example', 'f-example'],
  ];
  for (const [field, id] of pairs) {
    if (typeof p[field] !== 'string') continue;
    state.editorCard[field] = p[field];
    const el = $(id);
    if (el) el.value = p[field];
  }
  // 生成的人设不再塞自定义系统提示词：留空，让 buildSystemPrompt 按卡片内容自动拼
  const title = $('char-modal-title');
  if (title) title.textContent = t('char.edit', { name: state.editorCard.name || '' });
}

// 只有「会覆盖用户已经写下的文字」时才需要多问一句；空编辑器直接生成，不打扰。
function personaWouldOverwrite(p) {
  const pairs = [
    ['name', 'f-name'], ['description', 'f-desc'], ['personality', 'f-personality'],
    ['scenario', 'f-scenario'], ['first_mes', 'f-first'], ['mes_example', 'f-example'],
  ];
  return pairs.some(([field, id]) => {
    if (typeof p[field] !== 'string') return false;
    const el = $(id);
    const cur = el ? el.value.trim() : '';
    return !!cur && cur !== p[field];
  });
}

export async function generatePersona() {
  const s = getSettings();
  if (!hasApiKey('llm')) {
    toast(t('char.genNeedKey'));
    if (hooks.openLlmModal) hooks.openLlmModal();
    return;
  }
  const btn = $('f-generate');
  const seedEl = $('f-seed');
  const seed = seedEl ? seedEl.value.trim() : '';
  const label = btn ? btn.textContent : '';
  const setLabel = (text) => {
    if (!btn) return;
    btn.innerHTML = iconSvg('spark', 16) + '<span>' + escapeHtml(text) + '</span>';
  };
  if (btn) { btn.disabled = true; setLabel(t('char.genBusy')); }
  try {
    // 写一整张角色卡比日常闲聊费 token 得多，而且推理模型的开销是随机的。
    // 额度起步、被思考吃光或被截断后的重试，都在 generatePersonaCard 里处理，
    // 用户看到的始终只是「一次生成」。
    const p = await generatePersonaCard(s, seed);
    // 生成的是草稿不是圣旨：先问一句，别把用户手写的东西悄悄吃掉
    if (personaWouldOverwrite(p) && !confirm(t('char.genOverwrite'))) return;
    applyPersonaToEditor(p);
    toast(t('char.genOk'));
  } catch (err) {
    toast(String((err && err.message) || err), true);
  } finally {
    if (btn) { btn.disabled = false; setLabel(label || t('char.genBtn')); }
  }
}

export function closeCharModal() {
  const persona = $('modal-persona');
  if (persona) persona.classList.add('hidden');
  const back = state.editorReturnPage && state.editorReturnPage !== 'char-edit' ? state.editorReturnPage : 'characters';
  gotoPage(back);
}

export function saveCharModal() {
  const name = $('f-name').value.trim();
  if (!name) { toast(t('char.nameRequired'), true); return; }
  const card = state.editorCard;
  card.name = name;
  card.description = $('f-desc').value.trim();
  card.personality = $('f-personality').value.trim();
  card.scenario = $('f-scenario').value.trim();
  card.first_mes = $('f-first').value.trim();
  card.mes_example = $('f-example').value.trim();
  card.system_prompt = $('f-system').value.trim();
  card.model = $('f-model').value;
  card.voice = $('f-voice').value;
  card.updatedAt = Date.now();
  if (!card.createdAt) card.createdAt = Date.now();

  const file = cardFileName(card);
  return window.api.writeCharacter(file, card, state.editorFile ? 'update' : 'create').then(async (res) => {
    toast(t('char.saved'));
    await refreshCharacters(res.file);
    renderCharList();
    renderCharactersPage();
    gotoPage('characters');
  });
}

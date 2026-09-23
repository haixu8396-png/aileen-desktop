// ============================================================
// 角色卡 UI 控制器：列表、右键/更多菜单、编辑器、快捷更换模型语音
// ============================================================
import { getSettings, deepMerge } from './settings.js';
import { emptyCard, cardFileName } from './characters.js';
import { escapeHtml } from './markdown.js';
import { state, hooks, tts } from './state.js';
import { $, toast, scrollBottom, avatarUrl } from './dom.js';
import { renderMessages, saveChatFor, loadChatFor, clearChatFor, ttsSettingsForCharacter, setBusy } from './chat.js';
import { setStageModelIndex, updateStageModelName, syncOverlayModel } from './stage.js';
import { t } from './i18n.js';

export function findChar(file) {
  return state.characters.find((c) => c.file === file);
}

// ---------------- 角色列表 ----------------
export function renderCharList() {
  const box = $('char-list');
  if (!box) return;
  box.innerHTML = '';
  if (!state.characters.length) {
    box.innerHTML = '<div class="char-item" style="color:var(--muted)">' + t('nav.noChars') + '</div>';
    return;
  }
  for (const c of state.characters) {
    const item = document.createElement('div');
    item.className = 'char-item' + (state.current && state.current.file === c.file ? ' active' : '');
    item.dataset.file = c.file;
    const img = document.createElement('img');
    img.src = avatarUrl(c.data.avatar) || 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="16" fill="#2c3040"/><text x="40" y="50" font-size="30" text-anchor="middle" fill="#9aa0b4" font-family="sans-serif">' + escapeHtml((c.data.name || '?').slice(0, 1)) + '</text></svg>');
    img.onerror = () => { img.src = ''; };
    const meta = document.createElement('div');
    meta.style.cssText = 'min-width:0';
    const nm = document.createElement('div');
    nm.className = 'ci-name';
    nm.textContent = c.data.name || c.file;
    const ds = document.createElement('div');
    ds.className = 'ci-desc';
    ds.textContent = c.data.description || '';
    meta.appendChild(nm); meta.appendChild(ds);
    const more = document.createElement('button');
    more.className = 'ci-more';
    more.textContent = '⋯';
    more.title = '角色卡菜单';
    more.onclick = (e) => { e.stopPropagation(); openCharMenuAt(c.file, e.clientX, e.clientY); };
    item.appendChild(img); item.appendChild(meta); item.appendChild(more);
    item.onclick = () => selectCharacter(c.file, { greet: true });
    item.oncontextmenu = (e) => { e.preventDefault(); openCharMenuAt(c.file, e.clientX, e.clientY); };
    box.appendChild(item);
  }
}

export function renderEmptyState() {
  if (state.characters.length > 0) return;
  const av = $('chat-avatar');
  if (av) av.src = '';
  $('chat-name').textContent = 'AILEEN';
  $('chat-desc').textContent = t('chat.emptyDesc');
  const box = $('messages');
  box.innerHTML = '<div class="msg assistant">' + t('chat.welcome') + '</div>';
  scrollBottom();
}

export function updateChatHeader() {
  if (!state.current) { renderEmptyState(); return; }
  $('chat-avatar').src = avatarUrl(state.current.data.avatar);
  $('chat-name').textContent = state.current.data.name || state.current.file;
  $('chat-desc').textContent = state.current.data.description || '';
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

  // 绑定 Live2D 模型
  if (found.data.model) {
    const idx = state.models.findIndex((m) => m.file === found.data.model);
    if (idx >= 0) {
      setStageModelIndex(idx);
      if (state.oml2d && state.oml2d.modelIndex !== idx) state.oml2d.loadModelByIndex(idx);
    }
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
  $('f-avatar-preview').src = avatarUrl(state.editorCard.avatar);
  $('f-delete').classList.toggle('hidden', !state.editorFile);
  $('modal-char').classList.remove('hidden');
}

export function closeCharModal() {
  $('modal-char').classList.add('hidden');
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
  window.api.writeCharacter(file, card, state.editorFile ? 'update' : 'create').then((res) => {
    toast(t('char.saved'));
    closeCharModal();
    return refreshCharacters(res.file);
  });
}

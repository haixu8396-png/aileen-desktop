// ============================================================
// AILEEN — 渲染进程入口（启动 + 事件装配）
//
// 界面结构（0.8 UI 重构后）：
//   左侧导航（对话 / 角色 / 记忆与知识库 / 任务 / 设备与扩展 + 设置）
//   右侧主内容一次只显示一个页面；Live2D 只存在于独立的透明展台窗口。
//
// 控制器：
//   state.js           共享状态与跨模块回调
//   shell.js           页面路由 / 外观主题 / 弹出菜单 / 侧栏
//   dom.js             DOM 与交互小工具
//   pages.js           角色库 / 记忆 / 任务 / 设备页的渲染
//   stage.js           模型数据 + 展台控制（不再在主窗口渲染 Live2D）
//   chat.js            消息渲染 / 流式对话 / 聊天记录
//   characters-ui.js   角色列表 / 菜单 / 编辑器
//   modals.js          设置中心表单与连接测试
//   voice.js           实时语音对话
// ============================================================
import { loadSettings, getSettings, saveSettings, setSettingsCache } from './lib/settings.js';
import { streamChat } from './lib/llm.js';
import { LLM_PROVIDERS, state, hooks, stt, tts } from './lib/state.js';
import { $, toast, autoGrowInput } from './lib/dom.js';
import { applyIcons } from './lib/icons.js';
import {
  initLive2D, updateStageModelName, populateStageModelSelect, setStageModelIndex, syncOverlayModel,
  currentStageModel, stageModelDisabled, openModelModal, addModelFromFolder, addModelFromZip, showUrlForm, submitUrlForm,
  refreshModelsAfterAdd, applyStageScale, toggleStage, resetStagePosition, renderLocalList, renderUrlList,
  refreshStageCapabilities, applyStageSize, syncStageSizeSwitch,
} from './lib/stage.js';
// 「Live2D 精细控制」那一组（口型/待机动作/视线/画质/LOD/帧率）的绑定与落盘
import { bindLive2DSettings } from './lib/live2d-settings.js';
import {
  send, renderMessages, setBusy, ttsSettingsForCharacter, clearMessages, regenerateLast, resumeWithAgent, copyText,
} from './lib/chat.js';
import {
  renderCharList, renderEmptyState, selectCharacter, refreshCharacters, findChar,
  openCharMenuAt, closeCharMenu, duplicateCard, deleteCard,
  openQuickModal, saveQuickModal, openCharModal, closeCharModal, saveCharModal, populateModelSelect, setCharFilter, generatePersona, applyPersonaToEditor,
  updateChatHeader,
} from './lib/characters-ui.js';
import {
  fillAllSettings, initSettingsPage, refreshChatStatus, setAttachUI, openScreenPicker,
  openLlmModal, openTtsModal, openSttModal, openEmbeddingModal, openPerformModal, openThemeModal,
  fetchLlmModels, testLlmConnection, fetchTtsVoices, fetchSttModels, fetchEmbeddingModels, testEmbedding,
  saveLlmModal, saveTtsModal, saveSttModal, saveEmbeddingModal, saveMemoryScope, savePerformModal, saveThemeModal,
  renderThemePresets,
} from './lib/modals.js';
import {
  applyAppearance, bindAppearanceControls, fillAvatar, gotoPage, gotoSettings,
  initPopups, initSidebar, onPageEnter, openPopup, closePopups, setNavTaskCount, setSettingsSection, setSidebarStatus,
} from './lib/shell.js';
import {
  initCharactersPage, initMemoryPage, renderCharactersPage, renderMemoryPage, renderTasksPage,
  syncDevicesPage, initTasksPage,
} from './lib/pages.js';
import { startVoiceLoop, stopVoiceLoop, syncRealtimeUI } from './lib/voice.js';
import { initSessionCoordinator, broadcastSession } from './lib/session-coordinator.js';
import { createMemoryEngine } from './memory/engine.js';
import { createMemoryEmbedder } from './memory/embeddings.js';
import { createMemoryFsBridge } from './lib/memory-host.js';
import { openMcModal, bindMc } from './lib/minecraft.js';
import { createMarkerParser } from './lib/marker-parser.js';
import { createReplyPacer } from './lib/reply-pacer.js';
import { parsePersonaResponse, buildPersonaMessages } from './lib/persona.js';
import { openPersonaStudio, closePersonaStudio, bindPersonaStudio, studioFormOptions } from './lib/persona-studio.js';
import { openChessModal, bindChess } from './lib/chess.js';
import { initAgentUI, injectAgentEvent, setResumeHandler, handleAgentEvent, agentUiSnapshot, toggleAgentPanel, closeAgentPanel, beginAgentTurn, resetAgentRun } from './lib/agent-ui.js';
import { createToolRegistry, TOOL_SPECS, withBaseExecutors } from './agent/tool-registry.js';
import { buildPersonaSystemPrompt, personaPosition, assertPersonaPreserved } from './agent/context-engine.js';
import { t, setLang, getLang, applyI18n, LANGS } from './lib/i18n.js';

// 错误收集（供自检诊断使用）
window.__AILEEN_ERRORS = [];
window.addEventListener('error', (e) => {
  const msg = String(e.message || e || '').trim();
  if (msg) window.__AILEEN_ERRORS.push(msg);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  const msg = String((r && r.message) || r || '').trim();
  if (msg) window.__AILEEN_ERRORS.push('rejection: ' + msg);
});

/** 把跨模块回调注入 hooks，避免模块间循环依赖 */
function injectHooks() {
  hooks.openCharModal = openCharModal;
  hooks.renderMessages = renderMessages;
  hooks.renderEmptyState = renderEmptyState;
  hooks.refreshCharacters = refreshCharacters;
  hooks.selectCharacter = selectCharacter;
  hooks.populateModelSelect = populateModelSelect;
  hooks.populateStageModelSelect = populateStageModelSelect;
  hooks.setBusy = setBusy;
  hooks.autoGrowInput = autoGrowInput;
  hooks.ttsSettingsForCharacter = ttsSettingsForCharacter;
  hooks.renderCharList = renderCharList;
  hooks.updateStageModelName = updateStageModelName;
  hooks.setStageModelIndex = setStageModelIndex;
  hooks.rebuildLive2D = syncOverlayModel;
  hooks.openLlmModal = openLlmModal;
  hooks.setAttachUI = setAttachUI;
}

// ---------------- 启动 ----------------
async function boot() {
  injectHooks();
  state.appInfo = await window.api.appInfo();
  await loadSettings();
  setLang(getSettings().language || 'zh');
  applyAppearance(getSettings().appearance || { mode: 'light' });

  initSidebar();
  initPopups();
  bindAppearanceControls();

  state.models = await window.api.listModels();
  state.characters = await window.api.listCharacters();

  await new Promise((resolve) => {
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(resolve);
    else resolve();
  });

  initLive2D();
  populateModelSelect();
  renderCharList();
  initCharactersPage({
    selectCharacter: async (file) => {
      await selectCharacter(file, { greet: true });
      gotoPage('chat');
    },
    openMenu: (file, x, y) => openCharMenuAt(file, x, y),
    edit: (data, file) => openCharModal(data, file),
  });
  initMemoryPage();
  renderCharactersPage();
  renderEmptyState();
  updateChatHeader();

  const lastFile = localStorage.getItem('aileen.currentChar') || '';
  const first = state.characters.find((c) => c.file === lastFile) || state.characters[0] || null;
  if (first) await selectCharacter(first.file, { greet: true });

  bindCharMenuActions();
  bindChatMenu();
  bindCharEditor();
  bindComposer();
  bindChatEvents();
  bindStageSection();
  bindPages();
  bindAppMenu();
  initSettingsPage();
  fillAllSettings();
  bindSettingsNav();

  bindMc();
  bindChess();
  bindPersonaStudio();
  bindLive2DSettings();
  // 口型同步：TTS 播放时把音量包络转发给展台（展台拿它驱动嘴部参数）。
  // 关掉开关就不接，连 IPC 都不发。
  tts.onLevel = (level) => {
    const cfg = getSettings().live2d || {};
    if (!cfg.lipsync) return;
    try {
      const p = window.api.overlayMouth(level);
      if (p && typeof p.catch === 'function') p.catch(() => { /* 展台没开 */ });
    } catch (err) { /* 展台没开 */ }
  };
  initAgentUI();
  // 「继续执行」= 用检查点重开一次任务。回调在这里注入，避免 chat ↔ agent-ui 互相 import。
  setResumeHandler((checkpoint) => resumeWithAgent(checkpoint));

  // 双窗口会话协调器：展台发来的输入/操作统一交给这里（主窗口是会话所有者）
  initSessionCoordinator({
    onChat: (text) => { send(text); },
    onVoice: () => toggleVoiceLoop(),
    onModel: (index) => { setStageModelIndex(index); syncOverlayModel(); },
    onModelList: () => { broadcastSession('models'); },
  });

  // Agent 事件的总出口：对话里的活动卡负责画，chat.js 只负责发
  hooks.agentEvent = (type, payload) => {
    try { handleAgentEvent(type, payload); } catch (err) { console.warn('[agent] 事件处理失败', err && err.message); }
    if (type === 'status' && payload && payload.status) {
      state.agentStatus = String(payload.status);
      updateTaskBar();
      try { broadcastSession('status'); } catch (err2) { /* 忽略 */ }
    }
    renderTasksPage();
    syncDevicesPage();
  };
  initTasksPage();
  bindAgentEntries();

  buildLangSwitch();
  refreshChatStatus();
  applyI18n();
  // 图标：把 data-icon 占位替换成内联 SVG（在 i18n 之后 —— 先让文案落位，再补图形）
  applyIcons();
  window.dispatchEvent(new CustomEvent('aileen:settings-changed'));
  updateShellStatus();
  syncRealtimeUI();

  window.api.onOverlayState((st) => {
    const btn = $('btn-float-stage');
    if (btn) btn.classList.toggle('on', !!(st && st.visible));
  });
  window.api.onMenuAction((action) => {
    if (action === 'settings') gotoSettings();
    else if (action === 'about') openAboutModal();
    else if (action === 'datadir') openDataDir();
    else if (action === 'new-card') openCharModal(null, null);
    else if (action === 'import-card') importCard();
    else if (action === 'clear-chat') clearMessagesAndToast();
    else if (action === 'llm') openLlmModal();
    else if (action === 'tts') openTtsModal();
    else if (action === 'stt') openSttModal();
    else if (action === 'perform') openPerformModal();
    else if (action === 'persona') openPersonaStudio();
    else if (action === 'model') openModelModal();
    else if (action === 'theme') openThemeModal();
    else if (action === 'mc') openMcModal();
    else if (action === 'chess') openChessModal();
  });
  $('input').focus();
}

// ---------------- 状态同步（侧栏 / 输入区 / 任务提示） ----------------
function updateShellStatus() {
  const s = getSettings() || {};
  const hasKey = !!(s.llm && (s.llm.apiKeySet || s.llm.apiKey));
  const computerOn = !!(s.agent && s.agent.computerUse);
  let text = hasKey ? t('sidebar.ready') : t('sidebar.noKey');
  if (computerOn) text += ' · ' + t('agent.computerOn');
  setSidebarStatus(text, hasKey ? 'on' : 'warn');
  updateTaskBar();
  syncDevicesPage();
}

function updateTaskBar() {
  const bar = $('chat-taskbar');
  const text = $('chat-taskbar-text');
  const st = state.agentStatus || 'idle';
  const active = st && st !== 'idle' && st !== 'success' && st !== 'completed' && st !== 'error' && st !== 'failed' && st !== 'cancelled';
  if (bar) bar.classList.toggle('on', !!active);
  if (text) text.textContent = t('agent.state' + ({ waiting_approval: 'Waiting', using_tool: 'Tool', thinking: 'Thinking', planning: 'Thinking', working: 'Working' }[st] || 'Idle'));
  // 任务页的徽章由 renderTasksPage 统一负责（这里再写一遍会出现「原始状态名」）
  renderTasksPage();
}

// ---------------- 角色卡菜单 / 对话页更多菜单 ----------------
function bindCharMenuActions() {
  document.querySelectorAll('#char-menu button[data-act]').forEach((btn) => {
    btn.onclick = () => {
      const act = btn.dataset.act;
      const file = state.currentMenuFile;
      closeCharMenu();
      if (!file) return;
      const c = findChar(file);
      if (act === 'edit') { if (c) openCharModal(c.data, file); }
      else if (act === 'quick') openQuickModal(file);
      else if (act === 'duplicate') duplicateCard(file);
      else if (act === 'export') { if (c) window.api.exportCharacter(c.data).then((p) => p && toast(t('char.exportedTo', { path: p }))); }
      else if (act === 'delete') deleteCard(file);
    };
  });
}

function bindChatMenu() {
  const moreBtn = $('btn-char-actions');
  if (moreBtn) {
    moreBtn.onclick = () => {
      if (!state.current) { toast(t('chat.needCharacter'), true); return; }
      openPopup('chat-menu', moreBtn);
    };
  }
  const edit = $('btn-edit-card');
  if (edit) {
    edit.onclick = () => {
      closePopups();
      if (state.current) openCharModal(state.current.data, state.current.file);
    };
  }
  const speak = $('btn-speak');
  if (speak) {
    speak.onclick = () => {
      closePopups();
      import('./lib/chat.js').then(({ speakLast }) => {
        if (typeof speakLast === 'function') speakLast();
        else toast(t('chat.nothingToRead'));
      }).catch(() => toast(t('chat.nothingToRead'), true));
    };
  }
  const regen = $('btn-regen');
  if (regen) regen.onclick = () => { closePopups(); regenerateLast(); };
  const copy = $('btn-copy-chat');
  if (copy) {
    copy.onclick = async () => {
      closePopups();
      const text = (state.messages || []).map((m) => (m.role === 'user' ? '你：' : (state.current && state.current.data && state.current.data.name ? state.current.data.name + '：' : 'AILEEN：')) + String(m.content || '')).join('\n\n');
      if (!text) { toast(t('chat.nothingToCopy')); return; }
      await copyText(text);
    };
  }
  const clear = $('btn-clear');
  if (clear) clear.onclick = () => { closePopups(); clearMessagesAndToast(); };
}

function clearMessagesAndToast() {
  if (!state.messages.length) { toast(t('chat.cleared')); return; }
  if (!confirm(t('chat.confirmClear'))) return;
  clearMessages();
  toast(t('chat.cleared'));
}

// ---------------- 角色编辑页 ----------------
function bindCharEditor() {
  const back = $('f-back');
  if (back) back.onclick = closeCharModal;
  $('f-cancel').onclick = closeCharModal;
  $('f-save').onclick = saveCharModal;
  $('f-delete').onclick = async () => {
    if (!state.editorFile) return;
    const name = (state.editorCard && state.editorCard.name) || '';
    if (!confirm(t('char.confirmDelete', { name }))) return;
    await window.api.deleteCharacter(state.editorFile);
    closeCharModal();
    if (state.current && state.current.file === state.editorFile) state.current = null;
    await refreshCharacters();
    toast(t('char.deleted'));
  };
  $('f-export').onclick = async () => {
    const name = $('f-name').value.trim();
    const card = { ...state.editorCard, name: name || (state.editorCard && state.editorCard.name) };
    const res = await window.api.exportCharacter(card);
    if (res) toast(t('char.exportedTo', { path: res }));
  };
  const genBtn = $('f-generate');
  if (genBtn) genBtn.onclick = generatePersona;

  $('f-avatar-btn').onclick = async () => {
    const res = await window.api.chooseAvatar();
    if (res) {
      state.editorCard.avatar = res.rel;
      const a = $('f-avatar-preview');
      const b = $('f-avatar-preview-2');
      if (a) a.src = res.url;
      if (b) b.src = res.url;
    }
  };
  // 编辑页的实时预览：名字 / 简介 / 模型 / 声音跟着输入变化
  const syncPreview = () => {
    const name = ($('f-name').value || '').trim();
    const desc = ($('f-desc').value || '').trim();
    const modelSel = $('f-model');
    const voiceSel = $('f-voice');
    const n = $('f-preview-name');
    const d = $('f-preview-desc');
    const m = $('f-preview-model');
    const v = $('f-preview-voice');
    if (n) n.textContent = name || t('char.previewName');
    if (d) d.textContent = desc || t('char.previewDesc');
    if (m) m.textContent = modelSel && modelSel.value ? (modelSel.options[modelSel.selectedIndex] || {}).textContent || t('char.noModel') : t('char.noModel');
    if (v) v.textContent = voiceSel && voiceSel.value ? (voiceSel.options[voiceSel.selectedIndex] || {}).textContent || t('char.noVoice') : t('char.noVoice');
    const av = $('f-avatar-preview');
    const av2 = $('f-avatar-preview-2');
    const url = state.editorCard && state.editorCard.avatar ? (window.api && state.editorCard.avatar.startsWith('data:') ? state.editorCard.avatar : null) : null;
    if (av2) fillAvatar(av2, name || 'A', url || av2.src);
  };
  ['f-name', 'f-desc'].forEach((id) => { const el = $(id); if (el) el.addEventListener('input', syncPreview); });
  ['f-model', 'f-voice'].forEach((id) => { const el = $(id); if (el) el.addEventListener('change', syncPreview); });
}

// ---------------- 输入区 ----------------
function bindComposer() {
  $('btn-send').onclick = () => send($('input').value);
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send($('input').value);
    }
  });
  const input = $('input');
  input.addEventListener('input', () => {
    autoGrowInput();
    const btn = $('btn-send');
    if (btn) btn.disabled = !String(input.value || '').trim() || !!state.busy;
  });
  const stop = $('btn-stop');
  if (stop) {
    stop.onclick = () => {
      if (state.abortCtrl) state.abortCtrl.abort();
      setBusy(false);
    };
  }
  const attach = $('btn-attach');
  const fileInput = $('file-input');
  if (attach && fileInput) {
    attach.onclick = () => fileInput.click();
    fileInput.onchange = () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      if (!/^image\//.test(f.type)) { toast(t('chat.onlyImages'), true); return; }
      if (f.size > 8 * 1024 * 1024) { toast(t('screen.captureFailed', { msg: '>8MB' }), true); return; }
      const reader = new FileReader();
      reader.onload = () => {
        state.pendingImage = { dataURL: String(reader.result || ''), name: f.name };
        setAttachUI();
        toast(t('chat.attached'));
      };
      reader.readAsDataURL(f);
    };
  }
  const rm = $('attach-remove');
  if (rm) rm.onclick = () => { state.pendingImage = null; setAttachUI(); };
  const shot = $('btn-screenshot');
  if (shot) shot.onclick = () => openScreenPicker();
  const mic = $('btn-mic');
  if (mic) {
    mic.onclick = () => {
      if (stt.recognizing) { stt.stop(); return; }
      stt.onResult = (text) => {
        const box = $('input');
        box.value = (box.value ? box.value + ' ' : '') + text;
        autoGrowInput();
        box.focus();
        const btn = $('btn-send');
        if (btn) btn.disabled = false;
        toast(t('chat.recognized'));
      };
      stt.onError = (err) => toast(t('stt.failed', { msg: (err && err.message) || err }), true);
      stt.onState = (on) => mic.classList.toggle('recording', on);
      stt.start(getSettings());
    };
  }
  const realtime = $('btn-realtime');
  if (realtime) realtime.onclick = () => toggleVoiceLoop();
  const rtStop = $('btn-realtime-stop');
  if (rtStop) rtStop.onclick = () => stopVoiceLoop();

  // 屏幕截图弹窗
  const sc = $('screen-cancel');
  if (sc) sc.onclick = () => $('modal-screen').classList.add('hidden');
  const quickCancel = $('q-cancel');
  if (quickCancel) quickCancel.onclick = () => $('modal-quick').classList.add('hidden');
  $('q-save').onclick = saveQuickModal;
  const aboutCancel = $('about-cancel');
  if (aboutCancel) aboutCancel.onclick = () => $('modal-about').classList.add('hidden');
}

function toggleVoiceLoop() {
  if (state.voiceLoop) stopVoiceLoop();
  else startVoiceLoop();
  syncRealtimeUI();
}

// ---------------- 聊天区其它事件 ----------------
function bindChatEvents() {
  const down = $('btn-scroll-down');
  if (down) {
    down.onclick = () => {
      const box = $('messages');
      box.scrollTop = box.scrollHeight;
      down.classList.add('hidden');
    };
  }
  $('messages').addEventListener('scroll', () => {
    const box = $('messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const btn = $('btn-scroll-down');
    if (btn) btn.classList.toggle('hidden', nearBottom);
  });

  // 拖入图片 = 附件
  const panel = $('page-chat');
  const hint = $('drop-hint');
  if (panel) {
    let depth = 0;
    const show = (on) => { if (hint) hint.classList.toggle('hidden', !on); };
    panel.addEventListener('dragenter', (e) => { e.preventDefault(); depth += 1; show(true); });
    panel.addEventListener('dragover', (e) => { e.preventDefault(); });
    panel.addEventListener('dragleave', () => { depth -= 1; if (depth <= 0) { depth = 0; show(false); } });
    panel.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      show(false);
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f || !/^image\//.test(f.type)) return;
      if (f.size > 8 * 1024 * 1024) { toast(t('screen.captureFailed', { msg: '>8MB' }), true); return; }
      const reader = new FileReader();
      reader.onload = () => {
        state.pendingImage = { dataURL: String(reader.result || ''), name: f.name };
        setAttachUI();
        toast(t('chat.attached'));
      };
      reader.readAsDataURL(f);
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeCharMenu();
    closePopups();
    ['modal-screen', 'modal-quick', 'modal-about'].forEach((id) => { const el = $(id); if (el) el.classList.add('hidden'); });
  });
  ['modal-screen', 'modal-quick', 'modal-about'].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('click', (e) => { if (e.target === el) el.classList.add('hidden'); });
  });
}

// ---------------- 展台设置 ----------------
function bindStageSection() {
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  on('btn-add-model', addModelFromFolder);
  on('btn-add-zip-model', addModelFromZip);
  on('btn-add-url-model', showUrlForm);
  on('btn-refresh-models', refreshModelsAfterAdd);
  on('m-url-ok', submitUrlForm);
  on('m-url-cancel', () => $('m-url-form').classList.add('hidden'));
  const urlInput = $('m-url-input');
  if (urlInput) urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) submitUrlForm(); });
  on('m-cancel', () => gotoSettings('stage'));
  on('btn-stage-toggle', () => toggleStage().then(updateShellStatus));
  on('btn-stage-reset', () => resetStagePosition());
  const floatBtn = $('btn-float-stage');
  if (floatBtn) floatBtn.onclick = () => toggleStage().then(updateShellStatus);
  const scale = $('stage-scale');
  if (scale) scale.addEventListener('input', () => applyStageScale(parseFloat(scale.value)));
  // 「展台大小」三档：小 / 中 / 大（主进程还会按屏幕再钳一次）
  const sizeSwitch = $('stage-size-switch');
  if (sizeSwitch) {
    sizeSwitch.querySelectorAll('button[data-size]').forEach((b) => {
      b.onclick = () => applyStageSize(b.dataset.size);
    });
    syncStageSizeSwitch();
  }
}

// ---------------- 页面导航与设备 ----------------
function bindPages() {
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  on('btn-new-chat', () => { clearMessagesAndToast(); });
  on('btn-new-card', () => openCharModal(null, null));
  on('btn-import-card', () => importCard());
  on('btn-edit-current-card', () => { if (state.current) openCharModal(state.current.data, state.current.file); });
  on('btn-goto-characters', () => gotoPage('characters'));
  on('btn-goto-memory', () => { gotoPage('memory'); renderMemoryPage(); });
  on('btn-goto-devices', () => gotoPage('devices'));
  on('btn-goto-devices-mc', () => gotoPage('devices'));
  on('btn-goto-devices-chess', () => gotoPage('devices'));
  on('btn-open-data', () => openDataDir());
  on('btn-open-data-2', () => openDataDir());
  on('btn-open-about', () => openAboutModal());
  // 对话输入区的「Agent」按钮：弹层由 agent-ui.js 自己绑（主开关在弹层里）
  const search = $('char-search');
  if (search) search.addEventListener('input', (e) => setCharFilter(e.target.value));

  // 页面切换时刷新对应数据
  onPageEnter('characters', () => renderCharactersPage());
  onPageEnter('memory', () => renderMemoryPage());
  onPageEnter('tasks', () => renderTasksPage());
  onPageEnter('devices', () => syncDevicesPage());
  onPageEnter('settings', () => { fillAllSettings(); syncDevicesPage(); refreshStageCapabilities(); });
}

async function importCard() {
  const res = await window.api.importCharacter();
  if (res) {
    await refreshCharacters(res.file);
    renderCharactersPage();
    toast(t('char.imported'));
  }
}

function openDataDir() {
  const info = state.appInfo || {};
  window.api.openPath(info.userDataDir || info.dataDir || info.appRoot);
}

function openAboutModal() {
  const info = state.appInfo || {};
  const box = $('about-body');
  if (box) {
    box.innerHTML = '';
    const rows = [
      [t('about.app'), 'AILEEN ' + (info.version || '')],
      [t('about.electron'), info.electron || '-'],
      [t('about.node'), info.node || '-'],
      [t('about.datadir'), info.userDataDir || info.dataDir || '-'],
      [t('about.characters'), String((state.characters || []).length)],
      [t('about.models'), String((state.models || []).length)],
      [t('about.shortcuts'), 'F11 · ' + t('about.fullscreenHint')],
    ];
    for (const [k, v] of rows) {
      const row = document.createElement('div');
      row.className = 'about-row';
      const kk = document.createElement('span');
      kk.className = 'about-k';
      kk.textContent = k;
      const vv = document.createElement('span');
      vv.className = 'about-v';
      vv.textContent = v;
      vv.title = v;
      row.appendChild(kk);
      row.appendChild(vv);
      box.appendChild(row);
    }
  }
  $('modal-about').classList.remove('hidden');
}

// ---------------- 语言切换 ----------------
function buildLangSwitch() {
  const box = $('lang-switch');
  if (!box) return;
  box.innerHTML = '';
  for (const l of LANGS) {
    const b = document.createElement('button');
    b.textContent = l.label;
    b.className = getLang() === l.id ? 'on' : '';
    b.onclick = async () => {
      setLang(l.id);
      buildLangSwitch();
      const next = { ...getSettings(), language: l.id };
      await saveSettings(next);
      renderCharList();
      renderCharactersPage();
      updateChatHeader();
      renderMemoryPage();
      renderTasksPage();
      updateShellStatus();
      renderThemePresets();
      toast(t('menu.language') + ': ' + l.label);
    };
    box.appendChild(b);
  }
}

// ---------------- 设置分类导航 ----------------
function bindSettingsNav() {
  document.querySelectorAll('#settings-nav button').forEach((b) => {
    b.onclick = () => {
      setSettingsSection(b.dataset.sec);
      fillAllSettings();
      syncDevicesPage();
    };
  });
}

// ---------------- Agent 入口 ----------------
// 只有两处入口，而且都不再是「侧边控制台」：
//   · 对话输入区的 Agent 按钮 → 弹出权限面板（主开关、工作目录、最近的决定）
//   · 顶栏那个 Agent 图标 / 「任务进行中」提示条 → 任务页（任务记录就在这里）
function bindAgentEntries() {
  const toTasks = () => { gotoPage('tasks'); renderTasksPage(); };
  const bar = $('chat-taskbar');
  if (bar) bar.onclick = toTasks;
  const topBtn = $('btn-taskbar');
  if (topBtn) topBtn.onclick = toTasks;
  const tasksToChat = $('btn-tasks-to-chat');
  if (tasksToChat) tasksToChat.onclick = () => { gotoPage('chat'); toggleAgentPanel(); };
  const settingsToChat = $('btn-agent-to-chat');
  if (settingsToChat) settingsToChat.onclick = () => { gotoPage('chat'); toggleAgentPanel(); };
}

// ---------------- 原生应用菜单 ----------------
function bindAppMenu() { /* 菜单动作在 boot 的 onMenuAction 里统一处理 */ }

// ---------------- 自检辅助：让说话/朗读走同一套 ---------------- 
window.__aileenSpeakLast = () => {
  import('./lib/chat.js').then(({ speakLast }) => { if (typeof speakLast === 'function') speakLast(); });
};

// 自检钩子：复制到剪贴板必须真的能写（渲染层 clipboard 在 file:// 下会失败）
window.__AILEEN_PROBE_COPY = async () => {
  const text = 'AILEEN-COPY-' + Date.now();
  try {
    if (!window.api || typeof window.api.writeClipboard !== 'function') return { ok: false, error: '没有 writeClipboard' };
    await window.api.writeClipboard(text);
    return { ok: true, len: text.length };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
};

// 自检钩子：把标记解析器跑一遍，证明它在打包产物里真的可用
window.__AILEEN_PROBE_MARKERS = () => {
  let text = '';
  const kinds = [];
  const p = createMarkerParser({
    onText: (s) => { text += s; },
    onMarker: (m) => kinds.push(m.kind),
  });
  p.push('A<|mo');                        // 规范写法，故意切开
  p.push('tion:Tap|>B');                  // 接上
  p.push("<{'|'}expr:Happy");            // 线上写法，故意切开
  p.push("{'|'}>C");
  p.end();
  return { text, kinds };
};

// 自检钩子：节奏控制（delay 分段 + 真的等待）在打包产物里也要能跑
window.__AILEEN_PROBE_PACER = () => {
  let text = '';
  const breaks = [];
  const waits = [];
  const p = createReplyPacer({
    onText: (s) => { text += s; },
    onBreak: () => breaks.push(1),
    sleep: async (ms) => { waits.push(ms); },
  });
  p.push("在？<{'|'}del");
  p.push("ay:2{'|'}>算了没事");
  return p.finish().then(() => ({ text, breaks: breaks.length, waits }));
};

// 自检钩子：「不使用模型」这一档要真的生效（设置里选「不使用模型」，展台收到 null）
window.__AILEEN_PROBE_NOMODEL = async () => {
  const out = {};
  const sel = document.getElementById('m-model');
  out.hasOption = !!(sel && sel.querySelector('option[value="-1"]'));
  const prev = sel ? sel.value : null;
  if (sel) { sel.value = '-1'; sel.onchange({ target: sel, currentTarget: sel }); }
  out.modelIsNull = currentStageModel() === null;
  out.disabledFlag = stageModelDisabled() === true;
  // 主窗口不再渲染 Live2D：这里验证「推给展台的模型确实是 null」
  let overlayModel = 'unknown';
  try {
    const st = await window.api.overlayGetState();
    overlayModel = st ? (st.model || null) : null;
  } catch (err) { overlayModel = 'unavailable'; }
  out.overlayModelIsNull = overlayModel === null || overlayModel === 'unavailable';
  if (sel && prev) { sel.value = prev; sel.onchange({ target: sel, currentTarget: sel }); }
  out.restored = sel ? sel.value === prev : true;
  return out;
};

// 自检钩子（默认关闭，需要设置 AILEEN_SELFTEST_LIVE_LLM=1）：
// 真打一次 API，验证「渲染层 → 主进程 → 服务商 → 渲染层」这条新链路能流式回来。
// 这一步不能用 mock 代替 —— 密钥现在只在主进程，链路断了只有真跑才发现。
window.__AILEEN_PROBE_LIVE_LLM = async () => {
  let out = '';
  let think = 0;
  let finish = null;
  try {
    await streamChat({
      messages: [{ role: 'user', content: '只回答两个字：收到' }],
      settings: getSettings(),
      onDelta: (d) => { out += d; },
      onReasoning: (r) => { think += String(r || '').length; },
      onFinish: (i) => { finish = i; },
    });
    return { ok: true, chars: out.length, head: out.slice(0, 30), reasoningChars: think, finish: finish && finish.finishReason };
  } catch (err) {
    return { ok: false, message: String((err && err.message) || err), code: err && err.code };
  }
};

// 自检钩子：聊天消息区必须真的能上下滚动。
// 以前这里是个硬伤：grid 行高没约束 + flex 子项 min-height:auto，
// 消息一多整块被撑到窗口外面，被 body 的 overflow:hidden 裁掉 —— 没滚动条也滚不动。
window.__AILEEN_PROBE_SCROLL = (keep) => {
  // 先回到对话页：页面是单页切换的，别的页在前台时消息区高度是 0
  const chatNav = document.querySelector('#side-nav .nav-item[data-page="chat"]');
  if (chatNav) chatNav.click();
  const box = document.getElementById('messages');
  if (!box) return null;
  const cs = getComputedStyle(box);
  const before = box.scrollTop;
  const added = [];
  for (let i = 0; i < 30; i += 1) {
    const d = document.createElement('div');
    d.className = 'msg assistant';
    d.textContent = 'scroll-probe-' + i + ' ' + '滚动测试内容'.repeat(20);
    box.appendChild(d);
    added.push(d);
  }
  const out = {
    overflowY: cs.overflowY,
    boxH: box.clientHeight,
    winH: window.innerHeight,
    fitsWindow: box.clientHeight <= window.innerHeight,
    contentTaller: box.scrollHeight > box.clientHeight + 50,
  };
  box.scrollTop = box.scrollHeight;
  out.canScrollDown = box.scrollTop > 0;
  box.scrollTop = 0;
  out.canScrollUp = box.scrollTop === 0;
  if (!keep) {
    for (const d of added) d.remove();
    box.scrollTop = before;
  }
  return out;
};

// 自检钩子：截图用 —— 把聊天塞满，肉眼确认滚动条
window.__AILEEN_FILL_CHAT = () => {
  const box = document.getElementById('messages');
  if (!box) return false;
  for (let i = 0; i < 26; i += 1) {
    const d = document.createElement('div');
    d.className = 'msg assistant';
    d.textContent = '第 ' + (i + 1) + ' 条：' + '这是一条用来把聊天区撑满的消息，检查滚动条是否出现。'.repeat(2);
    box.appendChild(d);
  }
  box.scrollTop = 0;
  return true;
};

// 自检钩子：记忆库真机往返（渲染层 → store:fs → 主进程写盘 → 读回 → 检索 → 删掉）。
// 单测用的都是内存 fs，这条是唯一能证明「真机上真的能存能取能删」的路。
// 用一份**独立的探针文件**，绝不碰用户自己的记忆库。
window.__AILEEN_MEMORY_PROBE = async () => {
  const out = {
    ok: false, freshNotCorrupted: false, wrote: false, loadedBack: false,
    recalled: false, deleted: false, cleaned: false, mode: null, error: null,
  };
  const probePath = '__selftest-probe.json';
  const text = 'PROBE-' + Date.now() + '-记得我喜欢在晚上写代码';
  const makeEngine = (p) => createMemoryEngine({
    fs: createMemoryFsBridge(),
    filePath: p,
    // 本地向量就够验证链路了，不去打用户的嵌入接口
    embedder: createMemoryEmbedder({ localOnly: true }),
    logger: () => {},
  });
  try {
    // ① 全新用户第一次打开：文件不存在必须算「空库、正常」，不能报损坏
    const missing = makeEngine('__selftest-missing.json');
    const st0 = await missing.stats();
    out.freshNotCorrupted = st0.corrupted === false && !st0.loadError;

    // ② 写一条并落盘
    const engine = makeEngine(probePath);
    const rec = await engine.remember({ content: text, type: 'fact', importance: 0.9 });
    out.wrote = !!(rec && rec.id);
    await engine.flush();

    // ③ 换一个**全新的引擎实例**去读同一个文件 —— 这才叫真的落盘了，
    //    只信同一个引擎内存里那份记录等于什么都没验证
    const reader = makeEngine(probePath);
    const back = await reader.allRecords().catch(() => []);
    out.loadedBack = (back || []).some((r) => String(r.content || '').includes(text));

    const found = await reader.search(text, { k: 3, budgetTokens: 400, minRelevance: 0 });
    out.recalled = (found || []).some((r) => String(r.content || '').includes(text));
    out.mode = ((await reader.stats().catch(() => null)) || {}).embeddingMode || null;

    await engine.forget(rec.id);
    await engine.flush();
    const gone = await engine.get(rec.id).catch(() => null);
    out.deleted = !!(gone && gone.status === 'deleted');

    // ④ 探针文件用完就删，不在用户数据目录里留垃圾
    await window.api.storeFs({ op: 'remove', root: 'memory', path: probePath });
    const chk = await window.api.storeFs({ op: 'exists', root: 'memory', path: probePath });
    out.cleaned = !(chk && chk.exists);
    out.ok = out.freshNotCorrupted && out.wrote && out.loadedBack
      && out.recalled && out.deleted && out.cleaned;
  } catch (err) {
    out.error = String((err && err.message) || err);
  }
  return out;
};

// 自检钩子：检查点真机往返（渲染层 → 主进程写盘 → 读回 → 清除）
// 这是「跨重启续跑」的地基：单测用的是内存 fs，只有这条能证明真的落到了磁盘。
window.__AILEEN_CHECKPOINT_PROBE = async () => {
  const out = { ok: false, saved: false, loaded: false, cleared: false, error: null };
  const api = window.api || {};
  if (typeof api.agentCheckpoint !== 'function') { out.error = '没有 agentCheckpoint'; return out; }
  const data = { task: 'PROBE-' + Date.now(), checkpoint: { goal: 'probe', steps: [{ tool: 'read_file', ok: true }] }, rounds: 2 };
  try {
    await api.agentCheckpoint({ op: 'clear' });
    out.saved = !!(await api.agentCheckpoint({ op: 'save', data })).ok;
    const got = await api.agentCheckpoint({ op: 'load' });
    out.loaded = !!(got && got.data && got.data.task === data.task && got.data.checkpoint);
    out.cleared = !!(await api.agentCheckpoint({ op: 'clear' })).ok;
    const after = await api.agentCheckpoint({ op: 'load' });
    out.cleared = out.cleared && !after.data;
    out.ok = out.saved && out.loaded && out.cleared;
  } catch (err) {
    out.error = String((err && err.message) || err);
  }
  return out;
};

// 自检用：设备页的布局诊断（临时探针，回答「电脑控制按钮为什么占不到空间」）
window.__AILEEN_PROBE_DEVICES = () => {
  const nav = document.querySelector('#side-nav .nav-item[data-page="devices"]');
  if (nav) nav.click();
  const card = document.querySelector('#page-devices .device-card');
  const actions = card && card.querySelector('.dc-actions');
  const btn = document.getElementById('btn-computer');
  const info = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity, overflow: cs.overflow,
      position: cs.position, cls: el.className, text: (el.textContent || '').trim().slice(0, 30),
    };
  };
  return {
    card: info(card),
    actions: info(actions),
    btn: info(btn),
    cardChildren: card ? Array.from(card.children).map((c) => c.className || c.tagName) : [],
    btnParent: btn && btn.parentElement ? btn.parentElement.className : '',
    btnInCard: !!(card && btn && card.contains(btn)),
  };
};

// 自检钩子：按名字打开某个界面（截图核对排版用）
window.__AILEEN_OPEN = (name) => {
  const table = {
    persona: openPersonaStudio,
    'chat-scroll': () => { window.__AILEEN_FILL_CHAT(); },
    'persona-known': () => {
      openPersonaStudio();
      const r = document.getElementById('pa-mode-known');
      if (r) r.click();
    },
    perform: openPerformModal,
    char: () => openCharModal(null, null),
    llm: openLlmModal,
    tts: openTtsModal,
    stt: openSttModal,
    embed: openEmbeddingModal,
    model: openModelModal,
    theme: openThemeModal,
    menu: () => { gotoSettings('appearance'); return true; },
    settings: () => { gotoSettings(); return true; },
    'agent-settings': () => { gotoSettings('agent'); return true; },
    'stage-settings': () => { gotoSettings('stage'); return true; },
    characters: () => { gotoPage('characters'); return true; },
    memory: () => { gotoPage('memory'); return true; },
    tasks: () => { gotoPage('tasks'); return true; },
    devices: () => { gotoPage('devices'); return true; },
    agent: () => { gotoPage('chat'); return true; },
    // 截图用：把「Agent 已经在对话里干活 + 等确认」的样子摆出来
    dashboard: () => (typeof window.__AILEEN_PREVIEW_DASHBOARD === 'function' ? window.__AILEEN_PREVIEW_DASHBOARD() : false),
    // 截图用：只把权限弹层打开
    'agent-panel': () => { gotoPage('chat'); toggleAgentPanel(); return true; },
  };
  const fn = table[name];
  if (fn) { fn(); return true; }
  return false;
};

// 自检用：当前停在哪一页 / 哪个设置分类
window.__AILEEN_CURRENT_PAGE = () => ({
  page: (document.querySelector('#content .page.on') || {}).id || '',
  section: (document.querySelector('#settings-body .set-sec.on') || {}).id || '',
});

/**
 * 自检用的测试接口。
 * 把「人格是否保留」「Dashboard 是否由状态驱动」这类断言需要的东西暴露出来，
 * 让主进程的探针不用猜 DOM 结构。只在自检流程里被读，正常运行不使用。
 */
window.__AILEEN_AGENT_TEST = {
  /** 用当前角色卡拼一次 Agent 提示词，回报人格的位置与长度 */
  personaPosition() {
    const card = state.current && state.current.data ? state.current.data : {};
    const reg = createToolRegistry();
    reg.registerAll(withBaseExecutors(TOOL_SPECS));
    const tools = reg.list();
    const prompt = buildPersonaSystemPrompt({ card, tools, workspace: '' });
    const pos = personaPosition(card, prompt);
    let assertOk = false;
    try { assertPersonaPreserved(card, prompt); assertOk = true; } catch { assertOk = false; }
    return {
      found: pos.found,
      first: pos.first,
      personaChars: pos.personaChars,
      promptChars: pos.promptChars,
      toolCount: tools.length,
      assertOk,
      // 卡片自带 system_prompt 时，人格就是它
      builtInPrompt: !!(card && card.system_prompt && String(card.system_prompt).trim()),
    };
  },
  dashboard: {
    init: () => initAgentUI(),
    state: () => agentUiSnapshot(),
    event: (type, payload) => handleAgentEvent(type, payload),
    reset: () => resetAgentRun(),
  },
  /** 自检用：读当前 agent 设置（开关状态） */
  agentSettings() {
    return (getSettings() && getSettings().agent) || {};
  },
};

/**
 * 自检钩子：Agent 权限弹层（输入区那个按钮弹出来的东西）。
 * 刻意**不真跑 LLM**（那要花用户的额度），只插一条审批请求，
 * 检查：弹层能开能关能再开、控件齐、活动卡画得出来、审批按钮点得动。
 */
window.__AILEEN_PROBE_AGENT = async () => {
  const out = {};
  const chip = document.getElementById('btn-agent-mode');
  const panel = document.getElementById('agent-panel');
  if (!chip || !panel) { out.error = 'Agent 入口缺失'; return out; }
  // 从「关着」的基线开始：否则 chip.click() 会把已经开着的弹层关掉
  closeAgentPanel();
  // 用「点按钮」的方式打开（和用户手动操作同一条路），不是直接调函数
  chip.click();
  await new Promise((r) => setTimeout(r, 80));
  out.panelOpen = !panel.classList.contains('hidden');
  out.chipExpanded = chip.getAttribute('aria-expanded') === 'true';
  out.panelInComposer = !!panel.closest('#composer');
  out.noSideConsole = !document.getElementById('agent-drawer');
  for (const id of ['ap-enabled', 'ap-workspace-path', 'btn-ap-pick', 'btn-ap-open', 'ap-full', 'ap-skipwrite', 'ap-recent']) {
    out[id] = !!document.getElementById(id);
  }
  out.workspaceLabel = (document.getElementById('ap-workspace-path') || {}).textContent || '';
  // 再点一次收起；第三次再打开 —— 「收起之后还能再开」是硬要求
  chip.click();
  await new Promise((r) => setTimeout(r, 60));
  out.closedByChip = panel.classList.contains('hidden');
  out.chipCollapsed = chip.getAttribute('aria-expanded') === 'false';
  chip.click();
  await new Promise((r) => setTimeout(r, 60));
  out.reopened = !panel.classList.contains('hidden');
  window.__AILEEN_OPEN('chat');

  // 对话里的活动卡：挂一张卡，然后按真实事件流注入
  const app = window.__AILEEN_AGENT_TEST;
  app.dashboard.reset();
  beginAgentTurn('整理下载目录');
  injectAgentEvent('run_created', { run_id: 'probe-card', task: '整理下载目录' });
  injectAgentEvent('step', { step: 1, phase: 'llm' });
  injectAgentEvent('tool_call', { name: 'list_files', riskLevel: 'LOW' });
  injectAgentEvent('tool_result', { name: 'list_files', ok: true, summary: '3 个文件夹 / 12 个文件' });
  injectAgentEvent('approval_request', { id: 'probe-1', name: 'run_command', riskLevel: 'HIGH', preview: '要执行命令：npm run build', args: {} });
  const st = app.dashboard.state();
  out.cardVisible = st.cardVisible === true;
  out.cardRunning = st.cardRunning === true;
  out.cardTask = st.cardTask || '';
  out.stepLines = st.stepLines;
  out.approvalVisible = st.approvalVisible === true;
  out.approvalText = st.approvalText || '';
  out.approvalRisk = st.approvalRisk || '';
  out.hasApprove = !!document.querySelector('.agent-card .aa-approve');
  out.hasReject = !!document.querySelector('.agent-card .aa-reject');
  out.accentResolved = (() => {
    const rootStyle = document.documentElement ? getComputedStyle(document.documentElement) : null;
    return !!(rootStyle && rootStyle.getPropertyValue('--accent').trim());
  })();
  out.theme = document.documentElement.getAttribute('data-theme') || '';
  // 审批卡片故意留着不收：自检截图要看到它。
  // 截图之后由下面的 _AFTER 再点「拒绝」并断言卡片真的消失。
  return out;
};

// 截图前的视觉准备：把审批卡片摆出来（只为截图，不影响断言）
window.__AILEEN_PREVIEW_APPROVAL = () => {
  const app = window.__AILEEN_AGENT_TEST;
  window.__AILEEN_OPEN('chat');
  app.dashboard.reset();
  beginAgentTurn('整理下载目录');
  injectAgentEvent('run_created', { run_id: 'preview-card', task: '整理下载目录' });
  injectAgentEvent('tool_call', { name: 'list_files', riskLevel: 'LOW' });
  injectAgentEvent('tool_result', { name: 'list_files', ok: true, summary: '3 个文件夹 / 12 个文件' });
  injectAgentEvent('approval_request', {
    id: 'preview-1', name: 'run_command', riskLevel: 'HIGH', preview: '要执行命令：npm run build', args: {},
  });
  return true;
};

// 自检钩子：点亮「电脑控制」开关要**立刻**发生两件事
//   1) 开关本身立刻变（文案 + 高亮）
//   2) 输入区的 Agent 按钮跟着亮（同一个状态，不另开控制台）—— **但桌面展台不受影响**
// 验完把设置还原，避免影响后面的断言。
window.__AILEEN_PROBE_COMPUTER_TOGGLE = async () => {
  const out = {};
  const app = window.__AILEEN_AGENT_TEST;
  if (!app) { out.error = '测试接口未暴露'; return out; }
  // 开关在设备页：先切过去，否则 getBoundingClientRect 全是 0
  const devicesNav = document.querySelector('#side-nav .nav-item[data-page="devices"]');
  if (devicesNav) devicesNav.click();
  const btn = document.getElementById('btn-computer');
  const chip = document.getElementById('btn-agent-mode');
  const panel = document.getElementById('agent-panel');
  if (!btn || !chip || !panel) { out.error = '控件缺失'; return out; }
  // 弹层必须是「关着」的基线：否则下面点 chip 会把它关掉，断言就成了看运气
  closeAgentPanel();

  // 基线：确保「开关关掉 + 没有任务在跑」——否则开关的语义测不准
  app.dashboard.reset();
  if (app.agentSettings().computerUse === true) { btn.click(); await new Promise((r) => setTimeout(r, 80)); }
  out.baselineChipOff = !chip.classList.contains('on');
  out.noSideConsole = !document.getElementById('agent-drawer');
  let baselineOverlay = null;
  try { baselineOverlay = await window.api.overlayStatus(); } catch (err) { baselineOverlay = null; }
  out.baselineOverlayVisible = !!(baselineOverlay && baselineOverlay.visible);

  btn.click();
  await new Promise((r) => setTimeout(r, 60));

  out.settingOn = app.agentSettings().computerUse === true;
  out.btnText = (document.getElementById('btn-computer-label') || {}).textContent || btn.textContent;
  out.btnHighlighted = btn.classList.contains('computer-on');
  out.chipOn = chip.classList.contains('on');
  // 展台是**独立窗口**：主窗口里不能有任何 stage 容器
  out.mainWindowHasNoStage = !document.getElementById('stage-container');

  // 弹层打开时，设备页的开关必须**还点得到**（不能有透明遮罩盖住它）
  chip.click();
  await new Promise((r) => setTimeout(r, 80));
  out.panelOpenedByChip = !panel.classList.contains('hidden');
  out.panelMasterChecked = !!(document.getElementById('ap-enabled') || {}).checked;
  const r = btn.getBoundingClientRect();
  const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
  out.btnClickable = !!(top && (top === btn || btn.contains(top)));

  // 关掉 → 输入区按钮跟着灭、弹层里的主开关也灭
  btn.click();
  await new Promise((r) => setTimeout(r, 120));
  out.afterOff = {
    settingOff: app.agentSettings().computerUse !== true,
    chipOff: !chip.classList.contains('on'),
    masterOff: !(document.getElementById('ap-enabled') || {}).checked,
    stageAlwaysSeparate: !document.getElementById('stage-container'),
  };
  // 收尾：明确落到「关」的干净状态
  if (panel) closeAgentPanel();
  if (app.agentSettings().computerUse === true) { btn.click(); await new Promise((r2) => setTimeout(r2, 80)); }
  app.dashboard.reset();
  return out;
};

// 自检钩子：对话内活动卡 + 人格保留（不跑 LLM，不花额度）
// 这条守的是最硬的要求：人格原样保留、状态驱动界面、**主窗口里没有第二套舞台**。
window.__AILEEN_PROBE_DASHBOARD = async () => {
  const out = {};
  const app = window.__AILEEN_AGENT_TEST;
  if (!app) { out.error = '测试接口未暴露'; return out; }

  // ---- 1) 人格保留 ----
  const pos = app.personaPosition();
  out.personaFound = pos.found === true;
  out.personaFirst = pos.first === true;
  out.personaChars = pos.personaChars;
  out.builtInPrompt = pos.builtInPrompt === true;
  out.promptChars = pos.promptChars;
  out.toolCount = pos.toolCount;
  out.assertOk = pos.assertOk === true;

  // ---- 2) 活动卡由状态驱动 ----
  window.__AILEEN_OPEN('chat');
  app.dashboard.reset();
  await new Promise((r) => setTimeout(r, 60));
  const before = app.dashboard.state();
  out.cardHiddenBeforeRun = before.cardVisible === false;

  beginAgentTurn('打开浏览器搜索 AILEEN');
  app.dashboard.event('run_created', { run_id: 'probe', task: '打开浏览器搜索 AILEEN', maxRounds: 20 });
  app.dashboard.event('status', { status: 'planning' });
  app.dashboard.event('step', { step: 1, phase: 'llm' });
  app.dashboard.event('status', { status: 'thinking' });
  app.dashboard.event('tool_call', { name: 'window_list', riskLevel: 'LOW' });
  app.dashboard.event('tool_result', { name: 'window_list', ok: true, summary: '记事本 / Chrome' });
  app.dashboard.event('status', { status: 'using_tool' });
  app.dashboard.event('step', { step: 2, phase: 'tool', tool: 'open_application' });
  app.dashboard.event('approval_request', { id: 'ap-probe', name: 'mouse_click', riskLevel: 'HIGH', preview: '要点击鼠标left' });

  const mid = app.dashboard.state();
  out.cardVisibleDuringRun = mid.cardVisible === true;
  out.cardRunning = mid.cardRunning === true;
  out.mainWindowHasNoStage = !document.getElementById('stage-container');
  out.stageIsSeparateWindow = out.mainWindowHasNoStage;
  out.taskShown = mid.cardTask;
  out.statusText = mid.cardStatus;
  out.logLines = mid.stepLines;
  out.approvalShown = mid.approvalVisible === true;

  // ---- 3) 跑完之后卡片收尾（审批卡消失、不再是运行态） ----
  app.dashboard.event('status', { status: 'cancelled' });
  app.dashboard.event('finished', { status: 'cancelled' });
  const after = app.dashboard.state();
  out.approvalHiddenAfterFinish = after.approvalVisible === false;
  out.runningFalseAfterFinish = after.running === false;
  out.cardNotRunning = after.cardRunning === false;
  return out;
};

// 自检钩子：把「正在执行 + 等确认」的样子摆出来（截图用）
window.__AILEEN_PREVIEW_DASHBOARD = () => {
  const app = window.__AILEEN_AGENT_TEST;
  if (!app) return false;
  window.__AILEEN_OPEN('chat');
  app.dashboard.reset();
  beginAgentTurn('打开浏览器搜索 AILEEN 并告诉我结果');
  app.dashboard.event('run_created', { run_id: 'preview', task: '打开浏览器搜索 AILEEN 并告诉我结果', maxRounds: 20 });
  app.dashboard.event('status', { status: 'using_tool' });
  app.dashboard.event('step', { step: 2, phase: 'tool', tool: 'open_application' });
  app.dashboard.event('tool_call', { name: 'window_list', riskLevel: 'LOW' });
  app.dashboard.event('tool_result', { name: 'window_list', ok: true, summary: '记事本 / Chrome / 资源管理器' });
  app.dashboard.event('tool_call', { name: 'open_application', riskLevel: 'HIGH' });
  app.dashboard.event('status', { status: 'waiting_approval' });
  app.dashboard.event('approval_request', { id: 'preview-ap', name: 'open_application', riskLevel: 'HIGH', preview: '要打开程序或网址：https://example.com' });
  return true;
};

// 自检钩子：活动卡的交互收尾（审批的「拒绝」必须真的接上，收完卡片要清干净）
// 单独一个函数是为了让「截图」发生在本函数之前 —— 截图时卡片还在。
window.__AILEEN_PROBE_AGENT_AFTER = async () => {
  const out = {};
  const app = window.__AILEEN_AGENT_TEST;
  // 只看**最新那张**活动卡：旧卡还留在对话里当记录，querySelector 会抓到旧的
  const cards = document.querySelectorAll('.agent-card');
  const live = cards.length ? cards[cards.length - 1] : null;
  const box = live ? live.querySelector('.agent-approval') : null;
  out.visibleBeforeReject = !!box && !box.classList.contains('hidden');
  const reject = live ? live.querySelector('.aa-reject') : null;
  out.hasReject = !!reject;
  if (reject) reject.click();
  out.hiddenAfterReject = !!(box && box.classList.contains('hidden'));
  // 弹层也要真的收得起来：先确保关着，再开、再关
  closeAgentPanel();
  await new Promise((r) => setTimeout(r, 40));
  toggleAgentPanel();
  await new Promise((r) => setTimeout(r, 60));
  const panel = document.getElementById('agent-panel');
  out.panelOpenedByToggle = !!panel && !panel.classList.contains('hidden');
  closeAgentPanel();
  await new Promise((r) => setTimeout(r, 60));
  out.panelHiddenAfterClose = !!panel && panel.classList.contains('hidden');
  // 复位：下一项断言/截图不该被这张卡影响
  app.dashboard.reset();
  await new Promise((r) => setTimeout(r, 60));
  out.cardHiddenAfterReset = app.dashboard.state().cardVisible === false;
  out.mainWindowHasNoStage = !document.getElementById('stage-container');
  return out;
};

// 自检钩子：人设生成室（入口能开、原型能选、锁定真的改变了发给模型的提示词）
window.__AILEEN_PROBE_STUDIO = () => {
  const out = {};
  // 入口：设置 →「人设生成室」在角色编辑页里（不再是独立弹窗）
  gotoSettings('companion');
  const editBtn = document.getElementById('btn-edit-current-card');
  out.hasEntry = !!editBtn;
  if (editBtn) editBtn.click();
  const openStudio = document.getElementById('persona-wrap');
  if (openStudio) openStudio.open = true;
  openPersonaStudio();
  const m = document.getElementById('modal-persona');
  out.opened = !!m && !m.classList.contains('hidden');
  out.page = (document.querySelector('#content .page.on') || {}).id || '';
  out.chips = document.querySelectorAll('#pa-personalities .arch-chip').length;
  out.roleChips = document.querySelectorAll('#pa-roles .arch-chip').length;
  out.genders = document.querySelectorAll('#pa-gender option').length;
  out.hasLock = !!document.getElementById('pa-lock-p') && !!document.getElementById('pa-lock-r');
  out.hasSeed = !!document.getElementById('pa-seed');
  const chip = document.querySelector('#pa-personalities .arch-chip[data-arch-id]:not([data-arch-id=""])');
  out.picked = chip ? chip.dataset.archId : null;
  if (chip) chip.click();
  // 锁上之后，系统提示词里必须是硬约束口径；没锁则必须是「可以参考」口径。
  const locked = buildPersonaMessages({ personalityId: out.picked, lockPersonality: true, seed: 'x' });
  const soft = buildPersonaMessages({ personalityId: out.picked, lockPersonality: false, seed: 'x' });
  out.lockedHasRule = locked[0].content.indexOf(t('persona.lockHeader')) >= 0;
  out.softHasRule = soft[0].content.indexOf(t('persona.softHeader')) >= 0;
  out.lockedNotSoft = locked[0].content.indexOf(t('persona.softHeader')) < 0;
  const offChip = document.querySelector('#pa-personalities .arch-chip[data-arch-id=""]');
  out.canUnpick = !!offChip;
  if (offChip) offChip.click();
  const onChip = document.querySelector('#pa-personalities .arch-chip.on');
  out.unpicked = !!(onChip && onChip.dataset.archId === '');

  // 「已有角色」模式：字段要跟着换，而且选的东西必须真的进提示词
  const knownRadio = document.getElementById('pa-mode-known');
  if (knownRadio) knownRadio.click();
  out.knownVisible = !document.getElementById('pa-known-block').classList.contains('hidden');
  out.originalHidden = document.getElementById('pa-original-block').classList.contains('hidden');
  const charEl = document.getElementById('pa-char');
  if (charEl) charEl.value = '凉宫春日';
  const workEl = document.getElementById('pa-work');
  if (workEl) workEl.value = '凉宫春日的忧郁';
  if (offChip) offChip.click();   // 顺手清掉刚才选的原型
  const relEl = document.getElementById('pa-rel');
  out.relOptions = relEl ? relEl.querySelectorAll('option').length : 0;
  if (relEl) relEl.value = 'lover';
  const userEl = document.getElementById('pa-user');
  if (userEl) userEl.value = '小满';
  const opts = typeof studioFormOptions === 'function' ? studioFormOptions() : null;
  out.formMode = opts ? opts.mode : null;
  out.formChar = opts ? opts.charName : null;
  out.formRel = opts ? opts.relationId : null;
  out.formUser = opts ? opts.userName : null;
  const knownSys = opts ? buildPersonaMessages(opts)[0].content : '';
  out.knownPromptOk = knownSys.indexOf(t('persona.knownHeader')) >= 0 && knownSys.indexOf('凉宫春日') >= 0 && knownSys.indexOf('unknown') >= 0;
  out.relPromptOk = knownSys.indexOf(t('persona.relHeader')) >= 0 && knownSys.indexOf('小满') >= 0;
  out.knownNoArchetype = knownSys.indexOf(t('persona.lockHeader')) < 0;
  const backRadio = document.getElementById('pa-mode-original');
  if (backRadio) backRadio.click();
  out.backToOriginal = !document.getElementById('pa-original-block').classList.contains('hidden');
  closePersonaStudio();
  out.closed = !document.getElementById('modal-persona') || document.getElementById('modal-persona').classList.contains('hidden');
  return out;
};

// 自检钩子：逐页量「内容是不是比视口宽」——宽了就会出现横向滚动条、右侧被切掉。
// 返回越界清单（空数组 = 正常）。主进程会在大窗口和窄窗口各量一次。
window.__AILEEN_HSCROLL = async () => {
  const offenders = [];
  const navFor = (p) => document.querySelector('#side-nav .nav-item[data-page="' + p + '"]');
  const measure = (tag) => {
    const page = document.querySelector('#content .page.on');
    const body = (page && page.querySelector('.page-body')) || page;
    if (!body) return;
    // 「右侧被切掉」的定义是**元素真的伸出可视区**，不是 scrollWidth 比 clientWidth 大：
    // 后者在出现竖向滚动条时必然差几个像素（滚动条占掉了 clientWidth），是假阳性。
    const rect = body.getBoundingClientRect();
    const edge = rect.right - (body.offsetWidth - body.clientWidth); // 去掉竖向滚动条
    let worst = null;
    let worstOver = 0;
    for (const el of body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const o = Math.round(r.right - edge);
      if (o > worstOver) { worstOver = o; worst = el; }
    }
    if (worstOver > 1) {
      const who = worst ? ((worst.id && '#' + worst.id) || ('<.' + String(worst.className || worst.tagName).split(' ').join('.') + '>')) : '?';
      offenders.push(tag + ':over+' + worstOver + ' (' + who + ')');
    }
    const docOver = Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (docOver > 1) offenders.push(tag + ':doc+' + docOver);
  };
  const pages = ['settings', 'tasks', 'devices', 'characters', 'memory', 'chat'];
  for (const p of pages) {
    const nav = navFor(p);
    if (nav) { nav.click(); await new Promise((r) => setTimeout(r, 120)); }
    if (p === 'settings') {
      for (const b of Array.from(document.querySelectorAll('#settings-nav button'))) {
        b.click();
        await new Promise((r) => setTimeout(r, 60));
        measure('settings/' + (b.dataset.sec || '?'));
      }
    } else {
      measure(p);
    }
  }
  const chatNav = navFor('chat');
  if (chatNav) chatNav.click();
  return { offenders, viewport: [window.innerWidth, window.innerHeight] };
};

// 自检钩子：人设解析（围栏 + 废话 + 字符串里的大括号 + 空字段丢弃）
window.__AILEEN_PROBE_PERSONA = () => parsePersonaResponse(
  '好的，这是为你设计的角色：\n```json\n'
  + '{"name":"阿岚","description":"d","personality":"p{含括号}","scenario":"   ","first_mes":"f","mes_example":"m"}'
  + '\n```\n希望你喜欢！'
);

// 自检钩子：把生成结果回填进编辑器
window.__AILEEN_PROBE_PERSONA_APPLY = (p) => { applyPersonaToEditor(p); return true; };

// 自检钩子：主窗口里没有 Live2D 实例（角色只在展台窗口渲染）
window.__AILEEN_MODEL_READY = () => true;
window.__AILEEN_REFRESH = async () => {
  await refreshCharacters();
  renderCharactersPage();
  renderCharList();
  renderMemoryPage();
};

// 系统语音列表可能异步加载
if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => { /* 下次打开编辑弹窗时刷新 */ };
}

boot();


// ============================================================
// AILEEN — 渲染进程入口（启动 + 事件装配）
// 职责边界：控制器分布在 lib/ 下
//   state.js           共享状态与跨模块回调
//   dom.js             DOM/交互工具
//   stage.js           Live2D 舞台与模型管理
//   chat.js            消息渲染 / 流式对话 / 聊天记录
//   characters-ui.js   角色卡列表 / 菜单 / 编辑器
//   modals.js          设置弹窗 / 主题调色 / 屏幕视觉
//   voice.js           实时语音对话
// ============================================================
import { loadSettings, getSettings, saveSettings } from './lib/settings.js';
import { LLM_PROVIDERS, presetLlmBase, state, hooks, tts, stt } from './lib/state.js';
import { $, toast, autoGrowInput } from './lib/dom.js';
import { escapeHtml } from './lib/markdown.js';
import {
  initLive2D, rebuildLive2D, updateStageModelName, populateStageModelSelect, setStageModelIndex,
  openModelModal, addModelFromFolder, showUrlForm, submitUrlForm, refreshModelsAfterAdd, bindTtsMotion,
} from './lib/stage.js';
import {
  send, renderMessages, setBusy, ttsSettingsForCharacter, clearMessages,
} from './lib/chat.js';
import {
  renderCharList, renderEmptyState, selectCharacter, refreshCharacters, findChar,
  openCharMenuAt, closeCharMenu, duplicateCard, deleteCard,
  openQuickModal, saveQuickModal, openCharModal, closeCharModal, saveCharModal, populateModelSelect,
} from './lib/characters-ui.js';
import {
  openLlmModal, saveLlmModal, openTtsModal, saveTtsModal, openSttModal, saveSttModal,
  refreshMenuSubtitles, fetchLlmModels, testLlmConnection, fetchTtsVoices, fetchSttModels,
  applyTheme, openThemeModal, saveThemeModal, setAttachUI, openScreenPicker,
} from './lib/modals.js';
import { startVoiceLoop, stopVoiceLoop } from './lib/voice.js';

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
  hooks.rebuildLive2D = rebuildLive2D;
  hooks.openLlmModal = openLlmModal;
  hooks.setAttachUI = setAttachUI;
}

// ---------------- 启动 ----------------
async function boot() {
  injectHooks();
  state.appInfo = await window.api.appInfo();
  await loadSettings();
  applyTheme(getSettings().theme);
  state.models = await window.api.listModels();
  state.characters = await window.api.listCharacters();
  await new Promise((resolve) => {
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(resolve);
    else resolve();
  });

  bindTtsMotion();
  populateModelSelect();
  populateStageModelSelect();
  renderCharList();
  try {
    initLive2D();
  } catch (err) {
    console.error('[live2d] init failed:', err);
    $('stage-container').innerHTML = '<div class="stage-placeholder">Live2D 初始化失败：' + escapeHtml(String(err && err.message || err)) + '</div>';
  }
  renderEmptyState();

  const lastFile = localStorage.getItem('aileen.currentChar') || localStorage.getItem('elysia.currentChar');
  const first = state.characters.find((c) => c.file === lastFile) || state.characters[0] || null;
  if (first) await selectCharacter(first.file, { greet: true });

  bindEvents();
  $('input').focus();
}

// ---------------- 事件绑定 ----------------
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
      else if (act === 'export') { if (c) window.api.exportCharacter(c.data).then((p) => p && toast('已导出到 ' + p)); }
      else if (act === 'delete') deleteCard(file);
    };
  });
}

function bindCharEditor() {
  $('f-cancel').onclick = closeCharModal;
  $('f-save').onclick = saveCharModal;
  $('f-delete').onclick = async () => {
    if (!state.editorFile) return;
    if (!confirm('确定删除角色「' + state.editorCard.name + '」吗？')) return;
    await window.api.deleteCharacter(state.editorFile);
    closeCharModal();
    if (state.current && state.current.file === state.editorFile) state.current = null;
    await refreshCharacters();
    toast('角色已删除');
  };
  $('f-export').onclick = async () => {
    const name = $('f-name').value.trim();
    const card = { ...state.editorCard, name: name || state.editorCard.name };
    const res = await window.api.exportCharacter(card);
    if (res) toast('已导出到 ' + res);
  };
  $('f-avatar-btn').onclick = async () => {
    const res = await window.api.chooseAvatar();
    if (res) {
      state.editorCard.avatar = res.rel;
      $('f-avatar-preview').src = res.url;
    }
  };
}

function bindSettingsModals() {
  $('s-llm-cancel').onclick = () => $('modal-llm').classList.add('hidden');
  $('s-llm-save').onclick = saveLlmModal;
  $('s-tts-cancel').onclick = () => $('modal-tts').classList.add('hidden');
  $('s-tts-save').onclick = saveTtsModal;
  $('s-stt-cancel').onclick = () => $('modal-stt').classList.add('hidden');
  $('s-stt-save').onclick = saveSttModal;
  $('btn-llm-fetch').onclick = fetchLlmModels;
  $('btn-llm-test').onclick = testLlmConnection;
  $('btn-tts-fetch').onclick = fetchTtsVoices;
  $('btn-stt-fetch').onclick = fetchSttModels;

  // 供应商切换 / 自定义地址开关
  $('s-llm-provider').addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      $('s-llm-custom-url').checked = true;
      $('wrap-llm-base').classList.remove('hidden');
      return;
    }
    const p = LLM_PROVIDERS[e.target.value];
    if (p) {
      if (!$('s-llm-custom-url').checked) $('s-llm-base').value = p.baseUrl;
      $('s-llm-model').value = p.model;
    }
  });
  $('s-llm-custom-url').addEventListener('change', (e) => {
    const on = e.target.checked;
    $('wrap-llm-base').classList.toggle('hidden', !on);
    if (on && !$('s-llm-base').value.trim()) {
      $('s-llm-base').value = presetLlmBase($('s-llm-provider').value);
    }
  });
  $('s-tts-provider').addEventListener('change', (e) => {
    const isOpenai = e.target.value === 'openai';
    $('wrap-tts-custom').classList.toggle('hidden', !isOpenai);
    $('wrap-tts-base').classList.toggle('hidden', !(isOpenai && $('s-tts-custom-url').checked));
  });
  $('s-tts-custom-url').addEventListener('change', (e) => {
    $('wrap-tts-base').classList.toggle('hidden', !e.target.checked);
  });
  $('s-stt-provider').addEventListener('change', (e) => {
    const isOpenai = e.target.value === 'openai';
    $('wrap-stt-custom').classList.toggle('hidden', !isOpenai);
    $('wrap-stt-base').classList.toggle('hidden', !(isOpenai && $('s-stt-custom-url').checked));
  });
  $('s-stt-custom-url').addEventListener('change', (e) => {
    $('wrap-stt-base').classList.toggle('hidden', !e.target.checked);
  });
  $('s-tts-rate').addEventListener('input', (e) => {
    $('s-tts-rate-val').textContent = Number(e.target.value).toFixed(1) + '×';
  });
}

function bindThemeModal() {
  $('t-save').onclick = saveThemeModal;
  $('t-cancel').onclick = () => $('modal-theme').classList.add('hidden');
  $('t-reset').onclick = () => {
    $('t-primary').value = '#ff7eb3';
    $('t-secondary').value = '#38b0de';
    applyTheme({ primary: '#ff7eb3', secondary: '#38b0de' });
  };
  $('t-primary').addEventListener('input', (e) => applyTheme({ primary: e.target.value, secondary: $('t-secondary').value }));
  $('t-secondary').addEventListener('input', (e) => applyTheme({ primary: $('t-primary').value, secondary: e.target.value }));
}

function bindModelModal() {
  $('btn-add-model').onclick = addModelFromFolder;
  $('btn-add-url-model').onclick = showUrlForm;
  $('btn-refresh-models').onclick = refreshModelsAfterAdd;
  $('m-url-ok').onclick = submitUrlForm;
  $('m-url-cancel').onclick = () => $('m-url-form').classList.add('hidden');
  $('m-url-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) submitUrlForm(); });
  $('m-cancel').onclick = () => $('modal-model').classList.add('hidden');
  $('m-model').onchange = (e) => {
    const idx = parseInt(e.target.value, 10);
    if (!isNaN(idx) && state.oml2d) state.oml2d.loadModelByIndex(idx);
    updateStageModelName();
  };
}

function bindMisc() {
  // 滚动到底
  $('btn-scroll-down').onclick = () => {
    const box = $('messages');
    box.scrollTop = box.scrollHeight;
    $('btn-scroll-down').classList.add('hidden');
  };
  $('messages').addEventListener('scroll', () => {
    const box = $('messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    $('btn-scroll-down').classList.toggle('hidden', nearBottom);
  });

  // Esc 关闭弹窗/菜单（保留正在编辑的角色卡弹窗）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeCharMenu();
      document.querySelectorAll('.modal').forEach((m) => {
        if (m.id !== 'modal-char') m.classList.add('hidden');
      });
    }
  });

  // 点击遮罩关闭
  ['modal-llm', 'modal-tts', 'modal-stt', 'modal-screen', 'modal-menu', 'modal-model', 'modal-theme', 'modal-quick'].forEach((id) => {
    $(id).addEventListener('click', (e) => { if (e.target === $(id)) $(id).classList.add('hidden'); });
  });
  $('modal-char').addEventListener('click', (e) => { if (e.target === $('modal-char')) closeCharModal(); });
}

function bindEvents() {
  // 发送
  $('btn-send').onclick = () => send($('input').value);
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send($('input').value);
    }
  });
  $('input').addEventListener('input', autoGrowInput);

  // 停止 / 清空 / 朗读
  $('btn-stop').onclick = () => {
    if (state.abortCtrl) state.abortCtrl.abort();
    tts.cancel();
    setBusy(false);
  };
  $('btn-clear').onclick = () => { clearMessages(); toast('对话已清空'); };
  $('btn-speak').onclick = () => {
    if (state.lastAssistantText) tts.enqueue(state.lastAssistantText, ttsSettingsForCharacter());
    else toast('还没有可朗读的内容');
  };

  // 实时语音对话
  $('btn-realtime').onclick = () => {
    if (state.voiceLoop) stopVoiceLoop();
    else startVoiceLoop();
  };

  // 语音输入（单次）
  $('btn-mic').onclick = () => {
    const btn = $('btn-mic');
    if (stt.recognizing) { stt.stop(); return; }
    stt.onResult = (text) => {
      const input = $('input');
      input.value = (input.value ? input.value + ' ' : '') + text;
      autoGrowInput();
      input.focus();
      toast('识别完成');
    };
    stt.onError = (err) => toast('语音识别: ' + (err && err.message ? err.message : err), true);
    stt.onState = (on) => btn.classList.toggle('recording', on);
    stt.start(getSettings());
  };

  // 侧栏
  $('btn-new-card').onclick = () => openCharModal(null, null);
  $('btn-import-card').onclick = async () => {
    const res = await window.api.importCharacter();
    if (res) {
      await refreshCharacters(res.file);
      toast('角色卡已导入');
    }
  };
  $('btn-settings-menu').onclick = () => { refreshMenuSubtitles(); $('modal-menu').classList.remove('hidden'); };
  $('btn-open-data').onclick = () => window.api.openPath(state.appInfo.userDataDir || state.appInfo.dataDir || state.appInfo.appRoot);
  document.querySelectorAll('#modal-menu .menu-list button').forEach((btn) => {
    btn.onclick = () => {
      $('modal-menu').classList.add('hidden');
      $(btn.dataset.target).classList.remove('hidden');
    };
  });
  $('menu-cancel').onclick = () => $('modal-menu').classList.add('hidden');

  // 屏幕截图
  $('btn-screenshot').onclick = openScreenPicker;
  $('attach-remove').onclick = () => { state.pendingImage = null; setAttachUI(); };
  $('screen-cancel').onclick = () => $('modal-screen').classList.add('hidden');

  // 角色卡菜单
  bindCharMenuActions();
  $('btn-char-actions').onclick = () => {
    if (!state.current) { toast('请先选择角色卡', true); return; }
    const rect = $('btn-char-actions').getBoundingClientRect();
    openCharMenuAt(state.current.file, rect.left, rect.bottom + 4);
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#char-menu') && !e.target.closest('.ci-more') && !e.target.closest('#btn-char-actions')) {
      closeCharMenu();
    }
  });

  // 快捷更换模型 / 语音
  $('q-cancel').onclick = () => $('modal-quick').classList.add('hidden');
  $('q-save').onclick = saveQuickModal;

  // 其余弹窗
  bindCharEditor();
  bindSettingsModals();
  bindThemeModal();
  bindModelModal();
  bindMisc();
}

// 自检钩子
window.__AILEEN_MODEL_READY = () => {
  try { return !!(state.oml2d && state.oml2d.models && state.oml2d.models.model); } catch { return false; }
};
window.__AILEEN_REFRESH = async () => { await refreshCharacters(); };

// 系统语音列表可能异步加载
if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => { /* 下次打开编辑弹窗时刷新 */ };
}

boot();

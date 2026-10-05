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
import { streamChat } from './lib/llm.js';
import { LLM_PROVIDERS, presetLlmBase, presetEmbeddingBase, state, hooks, tts, stt } from './lib/state.js';
import { $, toast, autoGrowInput } from './lib/dom.js';
import { escapeHtml } from './lib/markdown.js';
import {
  initLive2D, rebuildLive2D, updateStageModelName, populateStageModelSelect, setStageModelIndex, syncOverlayModel,
  currentStageModel, stageModelDisabled,
  openModelModal, addModelFromFolder, showUrlForm, submitUrlForm, refreshModelsAfterAdd, bindTtsMotion, applyStageScale,
} from './lib/stage.js';
import {
  send, renderMessages, setBusy, ttsSettingsForCharacter, clearMessages, regenerateLast,
} from './lib/chat.js';
import {
  renderCharList, renderEmptyState, selectCharacter, refreshCharacters, findChar,
  openCharMenuAt, closeCharMenu, duplicateCard, deleteCard,
  openQuickModal, saveQuickModal, openCharModal, closeCharModal, saveCharModal, populateModelSelect, setCharFilter, generatePersona, applyPersonaToEditor,
} from './lib/characters-ui.js';
import {
  openLlmModal, saveLlmModal, openTtsModal, saveTtsModal, openSttModal, saveSttModal,
  refreshMenuSubtitles, fetchLlmModels, testLlmConnection, fetchTtsVoices, fetchSttModels,
  applyTheme, openThemeModal, saveThemeModal, setAttachUI, openScreenPicker,
  openSettingsMenu, openFromMenu, closeSubModal, markActivePreset, setMenuSub, refreshChatStatus,
  openPerformModal, savePerformModal,
  openEmbeddingModal, saveEmbeddingModal, fetchEmbeddingModels, testEmbedding,
} from './lib/modals.js';
import { startVoiceLoop, stopVoiceLoop } from './lib/voice.js';
import { openMcModal, bindMc } from './lib/minecraft.js';
import { createMarkerParser } from './lib/marker-parser.js';
import { createReplyPacer } from './lib/reply-pacer.js';
import { parsePersonaResponse, buildPersonaMessages } from './lib/persona.js';
import { openPersonaStudio, closePersonaStudio, bindPersonaStudio, studioFormOptions } from './lib/persona-studio.js';
import { openChessModal, bindChess } from './lib/chess.js';
import { initAgentUI, injectAgentEvent } from './lib/agent-ui.js';
import { initAgentDashboard, onAgentEvent, dashboardState, resetDashboard } from './lib/agent-dashboard.js';
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
  hooks.rebuildLive2D = rebuildLive2D;
  hooks.openLlmModal = openLlmModal;
  hooks.setAttachUI = setAttachUI;
}

// ---------------- 启动 ----------------
async function boot() {
  injectHooks();
  state.appInfo = await window.api.appInfo();
  await loadSettings();
  setLang(getSettings().language || 'en'); // 界面语言：默认英文
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
    $('stage-container').innerHTML = '<div class="stage-placeholder">' + escapeHtml(t('stage.initFailed', { msg: String(err && err.message || err) })) + '</div>';
  }
  renderEmptyState();

  const lastFile = localStorage.getItem('aileen.currentChar') || localStorage.getItem('elysia.currentChar');
  const first = state.characters.find((c) => c.file === lastFile) || state.characters[0] || null;
  if (first) await selectCharacter(first.file, { greet: true });

  bindEvents();
  bindLayout();
  bindDropImage();
  bindMc();
  bindChess();
  initAgentUI();
  // Agent 事件的总出口：Dashboard 负责画，chat.js 只负责发
  hooks.agentEvent = (type, payload) => {
    try { onAgentEvent(type, payload); } catch (err) { console.warn('[agent] dashboard 事件处理失败', err && err.message); }
  };
  initAgentDashboard();
  bindAppMenu();
  refreshChatStatus();
  buildLangSwitch();
  applyI18n();
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
  const genBtn = $('f-generate');
  if (genBtn) genBtn.onclick = generatePersona;

  $('f-avatar-btn').onclick = async () => {
    const res = await window.api.chooseAvatar();
    if (res) {
      state.editorCard.avatar = res.rel;
      $('f-avatar-preview').src = res.url;
    }
  };
}

function bindSettingsModals() {
  $('s-llm-cancel').onclick = () => closeSubModal('modal-llm');
  $('s-llm-save').onclick = saveLlmModal;
  $('s-tts-cancel').onclick = () => closeSubModal('modal-tts');
  $('s-tts-save').onclick = saveTtsModal;
  $('s-stt-cancel').onclick = () => closeSubModal('modal-stt');
  $('p-cancel').onclick = () => closeSubModal('modal-perform');
  bindPersonaStudio();
  $('p-save').onclick = savePerformModal;
  $('s-stt-save').onclick = saveSttModal;
  $('btn-llm-fetch').onclick = fetchLlmModels;
  $('btn-llm-test').onclick = testLlmConnection;
  $('btn-tts-fetch').onclick = fetchTtsVoices;
  $('btn-stt-fetch').onclick = fetchSttModels;

  // 嵌入模型（记忆 / 知识库）
  $('s-embed-cancel').onclick = () => closeSubModal('modal-embedding');
  $('s-embed-save').onclick = saveEmbeddingModal;
  $('btn-embed-fetch').onclick = fetchEmbeddingModels;
  $('btn-embed-test').onclick = testEmbedding;
  $('s-embed-provider').addEventListener('change', (e) => {
    const p = e.target.value;
    if (p === 'custom') {
      $('s-embed-custom-url').checked = true;
      $('wrap-embed-base').classList.remove('hidden');
    }
    // 换供应商时把地址与模型换成该家的默认值（用户仍可改）
    if (!presetEmbeddingBase(p)) return;
    if (!$('s-embed-custom-url').checked) {
      $('s-embed-base').value = presetEmbeddingBase(p);
      const modelEl = $('s-embed-model');
      if (modelEl) modelEl.value = presetEmbeddingModel(p) || modelEl.value;
    }
  });
  $('s-embed-custom-url').addEventListener('change', (e) => {
    $('wrap-embed-base').classList.toggle('hidden', !e.target.checked);
  });

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
  $('t-cancel').onclick = () => closeSubModal('modal-theme');
  $('t-reset').onclick = () => {
    $('t-primary').value = '#ff7eb3';
    $('t-secondary').value = '#38b0de';
    applyTheme({ primary: '#ff7eb3', secondary: '#38b0de' });
    markActivePreset();
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
  $('m-cancel').onclick = () => closeSubModal('modal-model');
  $('m-model').onchange = (e) => {
    const idx = parseInt(e.target.value, 10);
    // 选「不使用模型」要真的把舞台清掉；从「不使用」切回某个模型时要重建舞台 ——
    // 那条路上 state.oml2d 已经是 null 了，只调 loadModelByIndex 会什么都不发生。
    if (e.target.value === '-1' || !state.oml2d) rebuildLive2D();
    else if (!isNaN(idx)) state.oml2d.loadModelByIndex(idx);
    updateStageModelName();
    syncOverlayModel();
  };
}

// 侧栏 / 舞台的折叠（记住状态）
function bindLayout() {
  const app = $('app');
  const KS = 'aileen.ui.sideCollapsed';
  const KT = 'aileen.ui.stageCollapsed';
  const apply = () => {
    const side = localStorage.getItem(KS) === '1';
    const stage = localStorage.getItem(KT) === '1';
    app.classList.toggle('side-collapsed', side);
    app.classList.toggle('stage-collapsed', stage);
    const es = $('btn-expand-sidebar');
    const et = $('btn-expand-stage');
    if (es) es.classList.toggle('hidden', !side);
    if (et) et.classList.toggle('hidden', !stage);
  };
  const flip = (key) => { localStorage.setItem(key, localStorage.getItem(key) === '1' ? '0' : '1'); apply(); };
  const side = () => flip(KS);
  const stage = () => flip(KT);
  const cs = $('btn-collapse-sidebar'); if (cs) cs.onclick = side;
  const xs = $('btn-expand-sidebar'); if (xs) xs.onclick = side;
  const ct = $('btn-collapse-stage'); if (ct) ct.onclick = stage;
  const xt = $('btn-expand-stage'); if (xt) xt.onclick = stage;
  apply();
}

// 把图片拖进聊天区就能当截图附件
function bindDropImage() {
  const panel = $('chat-panel');
  const hint = $('drop-hint');
  if (!panel) return;
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

// 语言切换（菜单内联，不需要再弹一层窗）
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
      // 语言变了，动态文案要重画一遍
      renderCharList();
      populateStageModelSelect();
      updateStageModelName();
      refreshMenuSubtitles();
      toast(t('menu.language') + ': ' + l.label);
    };
    box.appendChild(b);
  }
}

// 原生应用菜单 → 渲染层动作
function bindAppMenu() {
  window.api.onMenuAction((action) => {
    const datadir = () => window.api.openPath(state.appInfo.userDataDir || state.appInfo.dataDir || state.appInfo.appRoot);
    const table = {
      settings: openSettingsMenu,
      about: openAboutModal,
      datadir,
      'new-card': () => openCharModal(null, null),
      'import-card': () => $('btn-import-card').click(),
      'clear-chat': () => { clearMessages(); toast('对话已清空'); },
      llm: openLlmModal,
      tts: openTtsModal,
      stt: openSttModal,
      perform: openPerformModal,
      persona: openPersonaStudio,
      model: openModelModal,
      theme: openThemeModal,
      mc: openMcModal,
      chess: openChessModal,
    };
    const fn = table[action];
    if (fn) fn();
  });
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
    if (e.key !== 'Escape') return;
    closeCharMenu();
    // 设置子弹窗走 closeSubModal，保证主题预览被还原、且能退回设置菜单
    ['modal-llm', 'modal-tts', 'modal-stt', 'modal-model', 'modal-theme', 'modal-perform', 'modal-persona'].forEach((id) => {
      if (!$(id).classList.contains('hidden')) closeSubModal(id);
    });
    ['modal-screen', 'modal-quick', 'modal-menu'].forEach((id) => $(id).classList.add('hidden'));
  });

  // 点击遮罩关闭
  ['modal-llm', 'modal-tts', 'modal-stt', 'modal-model', 'modal-theme', 'modal-perform', 'modal-persona'].forEach((id) => {
    $(id).addEventListener('click', (e) => { if (e.target === $(id)) closeSubModal(id); });
  });
  ['modal-screen', 'modal-menu', 'modal-quick'].forEach((id) => {
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
  $('btn-clear').onclick = () => {
    if (!state.messages.length) { toast(t('chat.cleared')); return; }
    if (!confirm(t('chat.confirmClear'))) return;
    clearMessages();
    toast(t('chat.cleared'));
  };
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
  $('btn-settings-menu').onclick = async () => {
    openSettingsMenu();
    const st = await window.api.overlayStatus();
    setMenuSub('menu-sub-overlay', st && st.visible ? '已开启 · 角色浮在桌面' : '已关闭 · 点一下开启');
  };
  $('btn-open-data').onclick = () => window.api.openPath(state.appInfo.userDataDir || state.appInfo.dataDir || state.appInfo.appRoot);
  // 每个设置页都必须走它自己的 open 函数，否则表单不回填、主题预览无法回滚
  const menuOpeners = {
    'modal-llm': openLlmModal,
    'modal-tts': openTtsModal,
    'modal-stt': openSttModal,
    'modal-model': openModelModal,
    'modal-theme': openThemeModal,
    'modal-perform': openPerformModal,
    'modal-persona': openPersonaStudio,
    'modal-embedding': openEmbeddingModal,
  };
  document.querySelectorAll('#modal-menu .menu-list button[data-target]').forEach((btn) => {
    btn.onclick = () => openFromMenu(btn.dataset.target, menuOpeners[btn.dataset.target]);
  });
  // 菜单里的「动作型」条目（开关类，不弹子页面）
  document.querySelectorAll('#modal-menu .menu-list button[data-action]').forEach((btn) => {
    btn.onclick = () => runMenuAction(btn.dataset.action);
  });
  $('menu-cancel').onclick = () => $('modal-menu').classList.add('hidden');
  $('about-cancel').onclick = () => $('modal-about').classList.add('hidden');
  window.api.onOverlayState((st) => setMenuSub('menu-sub-overlay', st && st.visible ? '已开启 · 角色浮在桌面' : '已关闭 · 点一下开启'));

  // 舞台侧栏：就地换模型、导入、刷新、缩放
  const stageSel = $('stage-model');
  if (stageSel) {
    stageSel.onchange = (e) => {
      const idx = parseInt(e.target.value, 10);
      const mSel = $('m-model');
      if (mSel) mSel.value = String(idx);
      if (e.target.value === '-1' || !state.oml2d) rebuildLive2D();
      else if (!isNaN(idx)) state.oml2d.loadModelByIndex(idx);
      updateStageModelName();
      syncOverlayModel();
    };
  }
  const stImport = $('btn-stage-import');
  if (stImport) stImport.onclick = addModelFromFolder;
  const stRefresh = $('btn-stage-refresh');
  if (stRefresh) stRefresh.onclick = refreshModelsAfterAdd;

  const scaleEl = $('stage-scale');
  if (scaleEl) {
    const cur = getSettings().stage && getSettings().stage.scale;
    scaleEl.value = String(Number.isFinite(Number(cur)) ? Number(cur) : 0.3);
    let scaleTimer = null;
    scaleEl.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value) || 0.3;
      applyStageScale(v);
      clearTimeout(scaleTimer);
      scaleTimer = setTimeout(() => {
        const s = getSettings();
        saveSettings({ ...s, stage: { ...(s.stage || {}), scale: v } }).catch(() => {});
      }, 400);
    });
  }

  // 侧栏搜索
  const search = $('char-search');
  if (search) search.addEventListener('input', (e) => setCharFilter(e.target.value));

  // 重新生成
  const regen = $('btn-regen');
  if (regen) regen.onclick = () => regenerateLast();

  // 舞台上的「悬浮展台」快捷按钮
  const floatBtn = $('btn-float-stage');
  if (floatBtn) floatBtn.onclick = () => toggleOverlayStage();

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

// ---------------- 设置菜单里的「动作型」条目 ----------------
function runMenuAction(action) {
  $('modal-menu').classList.add('hidden');
  if (action === 'overlay') toggleOverlayStage();
  else if (action === 'mc') openMcModal();
  else if (action === 'chess') openChessModal();
  else if (action === 'perform') openPerformModal();
  else if (action === 'datadir') window.api.openPath(state.appInfo.userDataDir || state.appInfo.dataDir || state.appInfo.appRoot);
  else if (action === 'about') openAboutModal();
}

async function toggleOverlayStage() {
  const on = await window.api.overlayToggle();
  toast(on ? '无边框展台已开启（右下角手柄可拖动）' : '无边框展台已关闭');
  refreshMenuSubtitles();
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
      row.appendChild(kk); row.appendChild(vv);
      box.appendChild(row);
    }
  }
  $('modal-about').classList.remove('hidden');
}

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

// 自检钩子：「不使用模型」这一档要真的生效（舞台清空、展台收到 null）
window.__AILEEN_PROBE_NOMODEL = async () => {
  const out = {};
  const sel = document.getElementById('m-model');
  const stageSel = document.getElementById('stage-model');
  out.hasOption = !!(sel && sel.querySelector('option[value="-1"]'));
  out.stageHasOption = !!(stageSel && stageSel.querySelector('option[value="-1"]'));
  const prev = sel ? sel.value : null;
  if (sel) { sel.value = '-1'; sel.onchange({ target: sel }); }
  out.modelIsNull = currentStageModel() === null;
  out.disabledFlag = stageModelDisabled() === true;
  const box = document.getElementById('stage-container');
  out.stageCleared = !!(box && !box.querySelector('canvas'));
  out.placeholder = !!(box && box.querySelector('.stage-placeholder'));
  // 恢复现场，并等模型重新加载完 —— 否则后面的 modelReady 断言会因为「正在加载」而误报
  if (sel && prev) { sel.value = prev; sel.onchange({ target: sel }); }
  // 打包版从 asar 里读模型比开发版慢，等待给足（宁可自检慢一点，也不要随机红）
  for (let i = 0; i < 80; i += 1) {
    if (typeof window.__AILEEN_MODEL_READY === 'function' && window.__AILEEN_MODEL_READY()) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  out.restoredReady = typeof window.__AILEEN_MODEL_READY === 'function' ? !!window.__AILEEN_MODEL_READY() : 'n/a';
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
    menu: openSettingsMenu,
    agent: () => { const b = $('btn-agent'); if (b) b.click(); return true; },
    // Dashboard 不是弹窗，它是常驻在右侧展台区域的；这里把它摆成「正在执行 + 等确认」
    dashboard: () => (typeof window.__AILEEN_PREVIEW_DASHBOARD === 'function' ? window.__AILEEN_PREVIEW_DASHBOARD() : false),
  };
  const fn = table[name];
  if (fn) { fn(); return true; }
  const m = document.getElementById('modal-' + name);
  if (!m) return false;
  m.classList.remove('hidden');
  return true;
};

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
    init: () => initAgentDashboard(),
    state: () => dashboardState(),
    event: (type, payload) => onAgentEvent(type, payload),
    reset: () => resetDashboard(),
  },
  /** 自检用：读当前 agent 设置（开关状态） */
  agentSettings() {
    return (getSettings() && getSettings().agent) || {};
  },
};

/**
 * 自检钩子：Agent 面板。
 * 刻意**不真跑 LLM**（那要花用户的额度），只插一条审批请求，
 * 检查：面板能开、控件在、审批卡片能画出来、按钮点得动。
 */
window.__AILEEN_PROBE_AGENT = async () => {
  const out = {};
  const panel = document.getElementById('agent-panel');
  window.__AILEEN_OPEN('agent');
  out.panelOpen = !!panel && !panel.classList.contains('hidden');
  for (const id of ['ag-task', 'ag-start', 'ag-pause', 'ag-resume', 'ag-cancel', 'ag-approval', 'ag-log', 'ag-status', 'ag-workspace']) {
    out[id] = !!document.getElementById(id);
  }
  out.workspaceLabel = (document.getElementById('ag-workspace') || {}).textContent || '';
  // 走和真实事件同一条路注入一条 HIGH 风险审批，看卡片与按钮
  injectAgentEvent('approval_request', { id: 'probe-1', name: 'run_command', riskLevel: 'HIGH', preview: '要执行命令：npm run build', args: {} });
  out.approvalVisible = !document.getElementById('ag-approval').classList.contains('hidden');
  out.approvalText = (document.getElementById('ag-approval-text') || {}).textContent || '';
  out.approvalRisk = (document.getElementById('ag-approval-risk') || {}).textContent || '';
  out.logLines = document.getElementById('ag-log').childElementCount;
  // Agent 模式的主色必须真的转蓝（改了 CSS 没生效的话这里会露出来）
  // 注意：--accent 在 Agent 模式下是 var(--accent-agent) 这样的**变量引用**，
  // getComputedStyle 会原样返回文本而不是解析结果 —— 所以读链尾那个确定值。
  const rootEl = document.documentElement;
  out.agentModeClass = !!(rootEl && rootEl.classList && rootEl.classList.contains('agent-mode'));
  const rootStyle = rootEl ? getComputedStyle(rootEl) : null;
  out.accentAgentVar = rootStyle ? rootStyle.getPropertyValue('--accent-agent').trim().toLowerCase() : '';
  out.accentInAgentMode = out.accentAgentVar;
  out.accentIsBlue = out.accentAgentVar === '#3d8bfd';
  // 主按钮必须真的跟着变（曾经只有 CSS 变量变了、按钮还是旧色）
  const startBtn = document.getElementById('ag-start');
  out.startBtnColor = startBtn ? getComputedStyle(startBtn).backgroundImage.toLowerCase() : '';
  out.startBtnIsBlue = /61,\s*139,\s*253|3d8bfd/.test(out.startBtnColor);
  // 审批卡片故意留着不收：自检截图要看到它。
  // 截图之后由下面的 _AFTER 再点「拒绝」并断言卡片真的消失。
  return out;
};

// 截图前的视觉准备：把审批卡片摆出来（只为截图，不影响断言）
window.__AILEEN_PREVIEW_APPROVAL = () => {
  window.__AILEEN_OPEN('agent');
  injectAgentEvent('approval_request', {
    id: 'preview-1', name: 'run_command', riskLevel: 'HIGH', preview: '要执行命令：npm run build', args: {},
  });
  return true;
};

// 自检钩子：点亮「电脑控制」开关要**立刻**发生两件事
//   1) 整个界面转蓝（主色 + 按钮）
//   2) 右侧 Live2D 立刻换成 Dashboard（不用等发消息）
// 验完把设置还原，避免影响后面的断言。
window.__AILEEN_PROBE_COMPUTER_TOGGLE = async () => {
  const out = {};
  const app = window.__AILEEN_AGENT_TEST;
  if (!app) { out.error = '测试接口未暴露'; return out; }
  const btn = document.getElementById('btn-computer');
  const dash = document.getElementById('agent-dashboard');
  const stage = document.getElementById('stage-container');
  if (!btn || !dash || !stage) { out.error = '控件缺失'; return out; }
  const rootEl = document.documentElement;

  // 基线：确保「开关关掉 + 没有任务在跑」——否则开关的语义测不准
  app.dashboard.reset();
  if (app.agentSettings().computerUse === true) { btn.click(); await new Promise((r) => setTimeout(r, 80)); }
  out.baselineDashboardHidden = dash.classList.contains('hidden');
  out.baselineStageVisible = !stage.classList.contains('hidden');

  btn.click();
  await new Promise((r) => setTimeout(r, 60));

  out.settingOn = app.agentSettings().computerUse === true;
  out.btnText = btn.textContent;
  out.btnHighlighted = btn.classList.contains('computer-on');
  out.modeClassOn = rootEl.classList.contains('agent-mode');
  out.accentBlue = getComputedStyle(rootEl).getPropertyValue('--accent-agent').trim().toLowerCase() === '#3d8bfd';
  out.startBtnBlue = /61,\s*139,\s*253|3d8bfd/.test(getComputedStyle(document.getElementById('ag-start')).backgroundImage.toLowerCase());
  out.dashboardShown = !dash.classList.contains('hidden');       // ← 立刻出现
  out.stageHidden = stage.classList.contains('hidden');           // ← Live2D 让位
  out.hintShown = (document.getElementById('dash-now') || {}).textContent || '';

  // 关掉 → 两样都要退回去
  btn.click();
  await new Promise((r) => setTimeout(r, 60));
  out.afterOff = {
    settingOff: app.agentSettings().computerUse !== true,
    modeClassOff: !rootEl.classList.contains('agent-mode'),
    dashboardHidden: dash.classList.contains('hidden'),
    stageBack: !stage.classList.contains('hidden'),
  };

  // 收尾：明确落到「关」的干净状态，不依赖探针开始时读到什么
  //（自检是流水线，后面的断言要一个确定的起点）
  if (app.agentSettings().computerUse === true) { btn.click(); await new Promise((r) => setTimeout(r, 80)); }
  app.dashboard.reset();
  return out;
};

// 自检钩子：Agent Control Dashboard + 人格保留（不跑 LLM，不花额度）
// 这条守的是本轮最硬的要求：状态驱动 Dashboard、Live2D 让位、以及
// **角色人格在 Agent 提示词里原样保留**。
window.__AILEEN_PROBE_DASHBOARD = () => {
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

  // ---- 2) Dashboard 由状态驱动 ----
  // 先复位：上一个预览（截图用的）会留下可见态，不复位的话
  // 「跑之前应该是隐藏的」这条基线断言拿到的是脏状态。
  app.dashboard.init();
  app.dashboard.reset();
  const before = app.dashboard.state();
  out.hiddenBeforeRun = before.visible === false;

  app.dashboard.event('run_created', { run_id: 'probe', task: '打开浏览器搜索 AILEEN', maxRounds: 20 });
  app.dashboard.event('status', { status: 'planning' });
  app.dashboard.event('step', { step: 1, phase: 'llm' });
  app.dashboard.event('status', { status: 'thinking' });
  app.dashboard.event('tool_call', { name: 'window_list', riskLevel: 'LOW' });
  app.dashboard.event('tool_result', { name: 'window_list', ok: true, summary: '记事本 / Chrome' });
  app.dashboard.event('status', { status: 'using_tool' });
  app.dashboard.event('approval_request', { id: 'ap-probe', name: 'mouse_click', riskLevel: 'HIGH', preview: '要点击鼠标left' });

  const mid = app.dashboard.state();
  out.visibleDuringRun = mid.visible === true;
  out.stageHiddenDuringRun = mid.stageHidden === true;   // Live2D 必须让位
  out.taskShown = mid.task;
  out.logLines = mid.logLines;
  out.approvalShown = mid.approvalVisible === true;
  out.statusText = mid.status;

  // ---- 3) 取消之后 Live2D 要回来 ----
  app.dashboard.event('status', { status: 'cancelled' });
  app.dashboard.event('finished', { status: 'cancelled' });
  const after = app.dashboard.state();
  out.approvalHiddenAfterFinish = after.approvalVisible === false;
  return out;
};

// 自检钩子：Dashboard 可见时把审批卡片摆出来（截图用）
window.__AILEEN_PREVIEW_DASHBOARD = () => {
  const app = window.__AILEEN_AGENT_TEST;
  if (!app) return false;
  app.dashboard.init();
  // 先把上一次预览可能留下的运行态清掉（否则「跑完要还原」这类判断会拿到脏状态）
  app.dashboard.event('finished', { status: 'completed' });
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

// 自检钩子：Agent 面板的交互收尾（审批卡片的拒绝按钮要真的接上）
// 单独一个函数是为了让「截图」发生在本函数之前 —— 截图时卡片还在。
window.__AILEEN_PROBE_AGENT_AFTER = () => {
  const out = {};
  const box = document.getElementById('ag-approval');
  out.visibleBeforeReject = !!box && !box.classList.contains('hidden');
  const reject = document.getElementById('ag-reject');
  out.hasReject = !!reject;
  if (reject) reject.click();
  out.hiddenAfterReject = !!box && box.classList.contains('hidden');
  // 关掉面板后主色要还原（蓝色只属于 Agent 模式）
  const panel = document.getElementById('agent-panel');
  const rootEl = document.documentElement;
  const closeBtn = document.getElementById('ag-close');
  if (closeBtn) closeBtn.click();
  else if (panel) panel.classList.add('hidden');
  out.panelHiddenAfterClose = !!panel && panel.classList.contains('hidden');
  out.modeClassAfterClose = !(rootEl && rootEl.classList && rootEl.classList.contains('agent-mode'));
  out.accentRestored = out.modeClassAfterClose;
  return out;
};

// 自检钩子：人设生成室（入口能开、原型能选、锁定真的改变了发给模型的提示词）
window.__AILEEN_PROBE_STUDIO = () => {
  const out = {};
  const menuBtn = document.getElementById('btn-settings-menu');
  if (menuBtn) menuBtn.click();
  const entry = document.querySelector('#modal-menu .menu-list button[data-target="modal-persona"]');
  out.hasEntry = !!entry;
  if (entry) entry.click();
  const m = document.getElementById('modal-persona');
  out.opened = !!m && !m.classList.contains('hidden');
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
  closeSubModal('modal-persona');
  document.getElementById('modal-menu').classList.add('hidden');
  return out;
};

// 自检钩子：人设解析（围栏 + 废话 + 字符串里的大括号 + 空字段丢弃）
window.__AILEEN_PROBE_PERSONA = () => parsePersonaResponse(
  '好的，这是为你设计的角色：\n```json\n'
  + '{"name":"阿岚","description":"d","personality":"p{含括号}","scenario":"   ","first_mes":"f","mes_example":"m"}'
  + '\n```\n希望你喜欢！'
);

// 自检钩子：把生成结果回填进编辑器
window.__AILEEN_PROBE_PERSONA_APPLY = (p) => { applyPersonaToEditor(p); return true; };

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

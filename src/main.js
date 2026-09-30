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
} from './lib/modals.js';
import { startVoiceLoop, stopVoiceLoop } from './lib/voice.js';
import { openMcModal, bindMc } from './lib/minecraft.js';
import { createMarkerParser } from './lib/marker-parser.js';
import { createReplyPacer } from './lib/reply-pacer.js';
import { parsePersonaResponse, buildPersonaMessages } from './lib/persona.js';
import { openPersonaStudio, closePersonaStudio, bindPersonaStudio, studioFormOptions } from './lib/persona-studio.js';
import { openChessModal, bindChess } from './lib/chess.js';
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
  for (let i = 0; i < 40; i += 1) {
    if (typeof window.__AILEEN_MODEL_READY === 'function' && window.__AILEEN_MODEL_READY()) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  out.restoredReady = typeof window.__AILEEN_MODEL_READY === 'function' ? !!window.__AILEEN_MODEL_READY() : 'n/a';
  return out;
};

// 自检钩子：按名字打开某个界面（截图核对排版用）
window.__AILEEN_OPEN = (name) => {
  const table = {
    persona: openPersonaStudio,
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
    model: openModelModal,
    theme: openThemeModal,
    menu: openSettingsMenu,
  };
  const fn = table[name];
  if (fn) { fn(); return true; }
  const m = document.getElementById('modal-' + name);
  if (!m) return false;
  m.classList.remove('hidden');
  return true;
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

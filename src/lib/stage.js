// ============================================================
// Live2D 舞台控制器：模型加载/切换、动作表情、模型管理（导入/网址/移除）
// ============================================================
import { loadOml2d } from 'oh-my-live2d';
import { state, hooks, tts } from './state.js';
import { $, toast } from './dom.js';
import { escapeHtml } from './markdown.js';

export function initLive2D() {
  const container = $('stage-container');
  if (!container) return;
  if (!state.models.length) {
    container.innerHTML = '<div class="stage-placeholder">还没有 Live2D 模型～<br>可以在「⚙ 设置 → 🎀 Live2D 模型设置」里<br>从文件夹导入或从网址加载。<br><button id="btn-goto-models" class="ghost">去添加模型</button></div>';
    const go = container.querySelector('#btn-goto-models');
    if (go) go.onclick = () => openModelModal();
    return;
  }
  const W = container.clientWidth || 400;
  const H = container.clientHeight || 600;
  // 关键：默认舞台是 position:fixed 且铺满视口，会盖住整个界面导致所有按钮无法点击。
  // 这里在模型级 stageStyle 强制 position:absolute，把舞台约束在右侧面板容器内。
  state.oml2d = loadOml2d({
    parentElement: container,
    primaryColor: '#ff7eb3',
    dockedPosition: 'right',
    transitionTime: 300,
    sayHello: false,
    menus: { disable: true },
    statusBar: { disable: true },
    tips: {
      idleTips: {
        message: ['戳戳我呀～', '想和你聊天呢 ✨', '今天也要开心哦'],
        interval: 30000,
        duration: 4000,
      },
      welcomeTips: { duration: 5000 },
    },
    models: state.models.map((m) => ({
      name: m.name,
      path: m.url,
      scale: 0.3,
      anchor: [0.5, 0.5],
      position: [W / 2, H * 0.55],
      motionPreloadStrategy: 'IDLE',
      stageStyle: {
        position: 'absolute',
        left: 0,
        top: 0,
        width: '100%',
        height: '100%',
        transform: 'none',
        zIndex: 1,
      },
    })),
  });
  state.oml2d.onLoad((status) => {
    if (status === 'success') { refreshStageControls(); syncOverlayModel(); }
  });
  if (state.oml2d && typeof state.oml2d.then === 'function') {
    state.oml2d.catch((err) => {
      console.error('[live2d] load failed:', err);
      const box = $('stage-container');
      if (box && !box.querySelector('canvas')) {
        box.innerHTML = '<div class="stage-placeholder">Live2D 加载失败：' + escapeHtml(String(err && err.message || err)) + '</div>';
      }
    });
  }
}

export function getLive2dModel() {
  try {
    return (state.oml2d && state.oml2d.models && state.oml2d.models.model) || null;
  } catch { return null; }
}

export function rebuildLive2D() {
  const container = $('stage-container');
  if (state.oml2d) {
    try { if (state.oml2d.pixiApp) state.oml2d.pixiApp.destroy(true); } catch { /* ignore */ }
    state.oml2d = null;
  }
  if (container) container.innerHTML = '';
  initLive2D();
}

export function refreshStageControls() {
  const model = getLive2dModel();
  const mc = $('motion-chips');
  const ec = $('expr-chips');
  if (!mc || !ec) return;
  mc.innerHTML = '';
  ec.innerHTML = '';
  if (!model) return;
  try {
    const mm = model.internalModel.motionManager;
    const groups = Object.keys(mm.motionGroups || {});
    mc.innerHTML = groups.length
      ? groups.map((g) => '<button class="chip" data-motion="' + escapeHtml(g) + '">' + escapeHtml(g) + '</button>').join('')
      : '<span style="color:var(--muted);font-size:12px">无动作</span>';
    const defs = (mm.expressionManager && mm.expressionManager.definitions) || [];
    ec.innerHTML = defs.length
      ? defs.map((d) => '<button class="chip" data-expr="' + escapeHtml(d.name) + '">' + escapeHtml(d.name) + '</button>').join('')
      : '<span style="color:var(--muted);font-size:12px">无表情</span>';
    mc.querySelectorAll('.chip').forEach((btn) => {
      btn.onclick = () => { try { model.motion(btn.dataset.motion); } catch (e) { toast('动作失败: ' + e.message, true); } };
    });
    ec.querySelectorAll('.chip').forEach((btn) => {
      btn.onclick = () => { try { model.expression(btn.dataset.expr); } catch (e) { toast('表情失败: ' + e.message, true); } };
    });
  } catch (e) {
    console.warn('refreshStageControls', e);
  }
}

export function talkMotionName() {
  const model = getLive2dModel();
  if (!model) return null;
  try {
    const groups = Object.keys(model.internalModel.motionManager.motionGroups || {});
    if (!groups.length) return null;
    const prefer = groups.find((g) => /tap|talk|speak|wave|greet/i.test(g));
    return prefer || groups.find((g) => !/idle/i.test(g)) || groups[0];
  } catch { return null; }
}

export function idleMotionName() {
  const model = getLive2dModel();
  if (!model) return null;
  try {
    const groups = Object.keys(model.internalModel.motionManager.motionGroups || {});
    return groups.find((g) => /idle/i.test(g)) || groups[0] || null;
  } catch { return null; }
}

/** TTS 朗读期间驱动角色动作（由 main.js 在启动时调用一次） */
export function bindTtsMotion() {
  tts.onStart = () => {
    const g = talkMotionName();
    const model = getLive2dModel();
    if (g && model) { try { model.motion(g); } catch { /* ignore */ } }
  };
  tts.onEnd = () => {
    const g = idleMotionName();
    const model = getLive2dModel();
    if (g && model) { try { model.motion(g); } catch { /* ignore */ } }
  };
  tts.onError = (err) => toast('朗读失败: ' + (err && err.message ? err.message : err), true);
}

export function updateStageModelName() {
  const sel = $('m-model');
  const hint = $('stage-model-name');
  if (!sel || !hint) return;
  const opt = sel.options[sel.selectedIndex];
  hint.textContent = opt && opt.value !== '-1' ? opt.textContent : '未加载模型';
}

export function populateStageModelSelect() {
  const el = $('m-model');
  if (!el) return;
  el.innerHTML = state.models.length
    ? state.models.map((m, i) => '<option value="' + i + '">' + escapeHtml(m.name) + '</option>').join('')
    : '<option value="-1">（无模型）</option>';
  updateStageModelName();
}

export function setStageModelIndex(idx) {
  const sel = $('m-model');
  if (sel && !isNaN(idx) && idx >= 0) sel.value = String(idx);
  syncOverlayModel();
}

/** 当前舞台应显示的模型（跟随舞台下拉框，退化到角色卡绑定，再退化到第一个） */
export function currentStageModel() {
  const sel = $('m-model');
  const idx = sel ? parseInt(sel.value, 10) : -1;
  if (!isNaN(idx) && idx >= 0 && state.models[idx]) return state.models[idx];
  const cur = state.current;
  if (cur && cur.data && cur.data.model) {
    const found = state.models.find((m) => m.file === cur.data.model);
    if (found) return found;
  }
  return state.models[0] || null;
}

/** 把当前模型同步给无边框悬浮展台（没开悬浮窗时是空操作） */
export function syncOverlayModel() {
  try {
    const m = currentStageModel();
    window.api.overlaySetModel(m ? { url: m.url, name: m.name } : null);
  } catch (err) { /* 悬浮窗不可用不影响主流程 */ }
}

// ---------------- 模型管理（设置 → 模型设置） ----------------
export function openModelModal() {
  populateStageModelSelect();
  renderUrlList();
  $('modal-model').classList.remove('hidden');
}

export async function addModelFromFolder() {
  const list = await window.api.addModelFolder();
  if (list) {
    await refreshModelsAfterAdd();
    toast('模型已导入到 models/ 目录');
  }
}

export function showUrlForm() {
  $('m-url-form').classList.remove('hidden');
  $('m-url-input').focus();
}

export async function submitUrlForm() {
  const url = $('m-url-input').value.trim();
  const name = $('m-url-name').value.trim() || 'URL 模型';
  if (!url) { toast('请输入模型网址', true); return; }
  try {
    const list = await window.api.addModelUrl({ name, url });
    if (list) {
      await refreshModelsAfterAdd();
      $('m-url-form').classList.add('hidden');
      $('m-url-input').value = '';
      $('m-url-name').value = '';
      toast('URL 模型已添加');
    }
  } catch (err) {
    toast('添加失败: ' + String(err && err.message || err), true);
  }
}

export function renderUrlList() {
  const box = $('m-url-list');
  if (!box) return;
  const urls = state.models.filter((m) => m.source === 'url');
  box.innerHTML = '';
  if (!urls.length) {
    box.innerHTML = '<div class="empty">暂无 URL 模型</div>';
    return;
  }
  for (const m of urls) {
    const item = document.createElement('div');
    item.className = 'url-item';
    const nm = document.createElement('span');
    nm.className = 'ui-name';
    nm.textContent = m.name;
    const url = document.createElement('span');
    url.className = 'ui-url';
    url.textContent = m.url;
    const rm = document.createElement('button');
    rm.textContent = '✕';
    rm.title = '移除';
    rm.onclick = async () => {
      state.models = await window.api.removeModelUrl(m.url);
      hooks.populateModelSelect();
      populateStageModelSelect();
      rebuildLive2D();
      renderUrlList();
      toast('已移除 ' + m.name);
    };
    item.appendChild(nm);
    item.appendChild(url);
    item.appendChild(rm);
    box.appendChild(item);
  }
}

export async function refreshModelsAfterAdd() {
  state.models = await window.api.listModels();
  hooks.populateModelSelect();
  populateStageModelSelect();
  rebuildLive2D();
  syncOverlayModel();
  const current = state.current;
  if (current && current.data.model) {
    const idx = state.models.findIndex((m) => m.file === current.data.model);
    if (idx >= 0) setStageModelIndex(idx);
  }
}

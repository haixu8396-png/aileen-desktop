// ============================================================
// AILEEN — 无边框悬浮展台渲染层
// 只做三件事：显示角色、上报交互热区、处理拖拽/缩放/隐藏
// 鼠标穿透由主进程按「热区 + 真实光标位置」判定，这里负责告知热区
// ============================================================
import { loadOml2d } from 'oh-my-live2d';
import { t, setLang } from './lib/i18n.js';

const stageBox = document.getElementById('ov-stage');
const tools = document.getElementById('ov-tools');
const grip = document.getElementById('ov-grip');
const lockBtn = document.getElementById('ov-lock');

let oml2d = null;
let overlayCfg = { scale: 0.45, opacity: 1 };
let currentModel = null;
let dragging = false;
let hovering = false;
let hideTimer = null;
let askedInteractive = null;

// ---------------- 交互热区 ----------------
function reportHitArea() {
  const r = tools.getBoundingClientRect();
  if (!r.width || !r.height) return false; // 还没排版，别上报全 0 热区
  window.api.overlaySetHitArea({ x: r.left, y: r.top, w: r.width, h: r.height });
  return true;
}

function overTools(x, y) {
  const r = tools.getBoundingClientRect();
  // 还没排版完（宽高为 0）时一律视为「不在把手上」，否则全 0 矩形会把整窗误判成可交互
  if (!r.width || !r.height) return false;
  const pad = 6; // 轻微外扩，保证不会碰到窗口边缘的系统缩放手柄
  return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
}

function showTools() {
  tools.classList.add('on');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!hovering && !dragging) tools.classList.remove('on');
  }, 2600);
}

function setInteractive(on) {
  if (askedInteractive === on) return;
  askedInteractive = on;
  window.api.overlaySetIgnore(!on);
}

document.addEventListener('mousemove', (e) => {
  if (dragging) return;
  const inside = overTools(e.clientX, e.clientY);
  hovering = inside;
  if (inside) { showTools(); setInteractive(true); }
  else setInteractive(false);
});
document.addEventListener('mouseleave', () => { hovering = false; setInteractive(false); });
window.addEventListener('blur', () => setInteractive(false));

// ---------------- 拖拽移动 ----------------
grip.addEventListener('pointerdown', async (e) => {
  e.preventDefault();
  dragging = true;
  showTools();
  try { grip.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  await window.api.overlayDragStart();
});
grip.addEventListener('pointermove', () => { if (dragging) window.api.overlayDragMove(); });
async function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  try { grip.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  await window.api.overlayDragEnd();
  showTools();
}
grip.addEventListener('pointerup', endDrag);
grip.addEventListener('pointercancel', endDrag);

// ---------------- 工具按钮 ----------------
document.getElementById('ov-smaller').onclick = () => { window.api.overlayResize({ dw: -40, dh: -64 }); showTools(); };
document.getElementById('ov-bigger').onclick = () => { window.api.overlayResize({ dw: 40, dh: 64 }); showTools(); };
lockBtn.onclick = async () => {
  const on = !lockBtn.classList.contains('on');
  lockBtn.classList.toggle('on', on);
  lockBtn.textContent = on ? '👆' : '🖱';
  lockBtn.title = on ? t('overlay.lockOn') : t('overlay.lockOff');
  await window.api.overlaySetInteractive(on);
  showTools();
};
document.getElementById('ov-hide').onclick = () => window.api.overlayHide();
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.api.overlayHide(); });

// ---------------- Live2D ----------------
function destroyStage() {
  if (oml2d) {
    try { if (oml2d.pixiApp) oml2d.pixiApp.destroy(true); } catch (err) { /* ignore */ }
    oml2d = null;
  }
  stageBox.innerHTML = '';
}

// oml2d 建 Pixi 应用时舞台元素还没插进文档，量到的是 0x0，于是绘制缓冲就是空的
// （之后它只在 window resize 时才会重新量）。所以挂载完必须主动让它重量一次尺寸。
// 只调 Pixi 渲染器；模型的位置/缩放必须在「模型真的加载完」之后才能碰，
// 否则库内部的 this.model.x = ... 会打在 undefined 上，把整条加载链打断。
function syncStageSize(adjustModel) {
  try {
    const app = oml2d && oml2d.pixiApp;
    const w = stageBox.clientWidth;
    const h = stageBox.clientHeight;
    if (!app || !w || !h) return false;
    if (typeof app.resize === 'function') app.resize();
    if (adjustModel && oml2d.models && oml2d.models.model) {
      // 模型加载时舞台还是 0 尺寸，位置/缩放都是按那个算的 —— 必须重算一次
      if (typeof oml2d.setModelScale === 'function') oml2d.setModelScale(overlayCfg.scale || 0.45);
      if (typeof oml2d.setModelPosition === 'function') oml2d.setModelPosition({ x: w / 2, y: h * 0.55 });
    }
    return true;
  } catch (err) { return false; }
}

// 舞台样式：库默认是 position:fixed + 滑入动画，会盖住整屏；这里钉在容器内。
const STAGE_STYLE = {
  position: 'absolute',
  left: 0,
  top: 0,
  width: '100%',
  height: '100%',
  transform: 'none',
  zIndex: 1,
};

function renderStage(model) {
  destroyStage();
  currentModel = model;
  if (!model || !model.url) {
    stageBox.innerHTML = '<div class="ov-empty">' + t('overlay.empty') + '</div>';
    return;
  }
  const W = window.innerWidth;
  const H = window.innerHeight;
  oml2d = loadOml2d({
    parentElement: stageBox,
    primaryColor: '#ff7eb3',
    // oh-my-live2d 判断「是不是手机」用的是 matchMedia('screen and (max-width: 768px)') ——
    // 那是**窗口宽度**，不是屏幕宽度。展台窗口天生就窄（400~600px），于是永远被当成手机：
    // 而它在手机模式下 mobileDisplay 默认 false，会直接跳过整个模型加载（stageChildren=0），
    // 同时只认 mobileStageStyle、把我们给的 stageStyle 丢掉 —— 两条加起来就是「展台一片空白」。
    mobileDisplay: true,
    dockedPosition: 'right',
    transitionTime: 300,
    sayHello: false,
    menus: { disable: true },
    statusBar: { disable: true },
    tips: { idleTips: { message: ['……'], interval: 600000, duration: 2000 } },
    models: [{
      name: model.name || 'model',
      path: model.url,
      scale: overlayCfg.scale || 0.45,
      anchor: [0.5, 0.5],
      position: [W / 2, H * 0.55],
      motionPreloadStrategy: 'IDLE',
      stageStyle: STAGE_STYLE,
      mobileStageStyle: STAGE_STYLE,   // 窗口一窄就会被判成 mobile，这条必须同样给
    }],
    stageStyle: STAGE_STYLE,           // 全局兜底：两条分支都会合并它
  });
  if (oml2d && typeof oml2d.onLoad === 'function') {
    oml2d.onLoad((status) => { syncStageSize(status === 'success'); });
  }
  if (oml2d && typeof oml2d.then === 'function') oml2d.catch(() => { /* 失败静默 */ });
  // 立刻对一次尺寸，滑入动画（300ms）结束后再对一次，防止中途被重置
  syncStageSize(false);
  setTimeout(() => syncStageSize(false), 120);
  setTimeout(() => syncStageSize(false), 520);
}

// ---------------- 启动 ----------------
async function init() {
  const st = await window.api.overlayGetState();
  if (st && st.language) setLang(st.language);
  overlayCfg = Object.assign(overlayCfg, (st && st.overlay) || {});
  stageBox.style.opacity = String(overlayCfg.opacity || 1);
  const lockOn = !!(st && st.overlay && st.overlay.interactive);
  lockBtn.classList.toggle('on', lockOn);
  lockBtn.textContent = lockOn ? '👆' : '🖱';
  renderStage(st && st.model);
  reportHitArea();
  showTools();
}

// 自检钩子：主进程要能问出「展台到底有没有把模型画出来」（这里没有日志通道，只能主动问）
// 展台的报错只在自己控制台里，收进数组供自检读出（否则「模型出不来」永远查不出原因）
window.__AILEEN_REJECTS = [];
window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  if (window.__AILEEN_REJECTS.length < 5) window.__AILEEN_REJECTS.push(String((r && r.stack) || r));
});

// 轻量就绪问询：模型加载是异步的，自检要轮询这个，而不是固定等待
window.__AILEEN_OVERLAY_READY = () => {
  try {
    return !!(oml2d && oml2d.models && oml2d.models.model && oml2d.models.model.internalModel);
  } catch (err) { return false; }
};

window.__AILEEN_OVERLAY_PROBE = () => {
  const app = oml2d && oml2d.pixiApp;
  const canvas = document.querySelector('#ov-stage canvas');
  return {
    hasInstance: !!oml2d,
    hasPixiApp: !!app,
    rendererSize: app && app.app && app.app.renderer ? [app.app.renderer.width, app.app.renderer.height] : null,
    canvasAttr: canvas ? [canvas.width, canvas.height] : null,
    canvasCss: canvas ? [Math.round(canvas.getBoundingClientRect().width), Math.round(canvas.getBoundingClientRect().height)] : null,
    stageRect: (function () { const s = document.getElementById('oml2d-stage'); if (!s) return null; const r = s.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
    synced: syncStageSize(),
    hasModel: !!currentModel,
    rejects: window.__AILEEN_REJECTS.slice(0, 4),
    mqMobile: window.matchMedia('screen and (max-width: 768px)').matches,
    screenSize: [window.screen.width, window.screen.height],
    innerSize: [window.innerWidth, window.innerHeight],
    modelUrl: currentModel ? currentModel.url : null,
    stageChildren: app && app.app && app.app.stage ? app.app.stage.children.length : null,
    renderedOk: (function () {
      try {
        const r = app.app.renderer;
        const gl = r.gl;
        if (!gl) return false;
        const W = gl.drawingBufferWidth;
        const H = gl.drawingBufferHeight;
        r.render(app.app.stage);
        const px = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let n = 0;
        for (let i = 3; i < px.length; i += 4 * 97) { if (px[i] > 8) n += 1; }
        return n > 20;
      } catch (e) { return 'err:' + e.message; }
    })(),
    modelTransform: (function () {
      try {
        const kids = app.app.stage.children;
        if (!kids || !kids.length) return null;
        const m = kids[0];
        return { x: Math.round(m.x), y: Math.round(m.y), sx: Number(m.scale.x.toFixed(3)), alpha: m.alpha, visible: m.visible, w: Math.round(m.width), h: Math.round(m.height) };
      } catch (e) { return 'err:' + e.message; }
    })(),
    status: (function () { try { return oml2d && oml2d.models && oml2d.models.model && oml2d.models.model.internalModel ? 'internalModel-ok' : 'no-internalModel'; } catch (e) { return 'err:' + e.message; } })(),
    fb: (function () {
      try {
        const r = app.app.renderer;
        const gl = r.gl;
        if (!gl) return 'no-gl';
        const W = gl.drawingBufferWidth;
        const H = gl.drawingBufferHeight;
        // 必须先同步渲染一帧再读：默认的绘制缓冲不保留，呈现之后再 readPixels 只会读到全 0
        r.render(app.app.stage);
        const px = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let nonzero = 0;
        for (let i = 3; i < px.length; i += 4 * 97) { if (px[i] > 8) nonzero += 1; }
        return { drawBuf: [W, H], sampled: Math.floor(px.length / (4 * 97)), nonzero };
      } catch (e) { return 'err:' + e.message; }
    })(),
    emptyHint: !!document.querySelector('.ov-empty'),
  };
};

window.api.onOverlayModel((m) => renderStage(m));
window.addEventListener('resize', () => {
  reportHitArea();
  if (currentModel) renderStage(currentModel);
});
window.addEventListener('load', reportHitArea);
setTimeout(reportHitArea, 400);

init().catch((err) => console.error('[overlay] init failed', err));

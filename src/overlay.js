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
      stageStyle: { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', transform: 'none', zIndex: 1 },
    }],
  });
  if (oml2d && typeof oml2d.then === 'function') oml2d.catch(() => { /* 失败静默 */ });
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

window.api.onOverlayModel((m) => renderStage(m));
window.addEventListener('resize', () => {
  reportHitArea();
  if (currentModel) renderStage(currentModel);
});
window.addEventListener('load', reportHitArea);
setTimeout(reportHitArea, 400);

init().catch((err) => console.error('[overlay] init failed', err));

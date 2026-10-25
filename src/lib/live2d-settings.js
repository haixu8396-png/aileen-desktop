// ============================================================
// Live2D 精细控制（设置 →「Live2D 与桌面展台」里的那一组）
//
// 为什么单独一个模块：这一组全是「展台渲染层怎么画」的参数，和模型管理、窗口位置
// 都不相干。放在 main.js 里会把它继续撑大，而它自己没有任何主流程依赖 ——
// 只读 getSettings()，只调 saveSettings({ live2d })。
//
// 约定了三件事：
//   1) 每个控件都先切本地缓存再落盘（saveSettings 是异步的，等它回来再重画会落后一拍）；
//   2) 滑块拖动期间只更新数字，停手 250ms 才落盘（不然一次拖动写几十次设置）；
//   3) 落盘走主进程的 settings:set，主进程会把 live2d 推给展台 —— 展台立刻重排/重画。
// ============================================================
import { getSettings, saveSettings } from './settings.js';
import { $, toast } from './dom.js';
import { t } from './i18n.js';

const DEFAULTS = {
  fit: 0.95,
  zoom: 1,
  offsetY: 0,
  lipsync: true,
  lipsyncGain: 1.2,
  idleMotion: true,
  idleInterval: 14,
  focusFollow: true,
  physics: true,
  quality: 'auto',
  fps: 60,
  lod: 'auto',
  mask: 'auto',
};

function cfg() {
  return Object.assign({}, DEFAULTS, (getSettings() && getSettings().live2d) || {});
}

let saveTimer = null;

/** 写一组字段（debounce：滑块拖动只落一次盘） */
function patchLive2D(patch, { immediate = false } = {}) {
  const next = Object.assign({}, cfg(), patch || {});
  // ① 先切本地缓存：控件状态与数字立刻对上
  const s = getSettings();
  if (s) s.live2d = next;
  // ② 再落盘
  const write = () => {
    saveTimer = null;
    saveSettings({ live2d: next })
      .then(() => flashSaved())
      .catch((err) => toast(String((err && err.message) || err), true));
  };
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (immediate) write();
  else saveTimer = setTimeout(write, 250);
}

function flashSaved() {
  const hint = document.querySelector('#set-live2d-fine .saved-hint');
  if (!hint) return;
  hint.classList.add('show');
  clearTimeout(flashSaved.timer);
  flashSaved.timer = setTimeout(() => hint.classList.remove('show'), 1200);
}

// ---------------- 分段按钮 ----------------
function setSeg(id, value) {
  const box = $(id);
  if (!box) return;
  const v = String(value);
  box.querySelectorAll('button[data-val]').forEach((b) => {
    const on = b.dataset.val === v;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function bindSeg(id, apply, immediate = true) {
  const box = $(id);
  if (!box) return;
  box.querySelectorAll('button[data-val]').forEach((b) => {
    b.onclick = () => {
      setSeg(id, b.dataset.val);
      apply(b.dataset.val, { immediate });
    };
  });
}

// ---------------- 滑块 ----------------
function setRange(id, value, digits) {
  const el = $(id);
  if (!el) return;
  const v = Number(value);
  if (document.activeElement !== el) el.value = String(v);
  const out = $(id + '-val');
  if (out) out.textContent = digits === 0 ? String(Math.round(v)) : v.toFixed(digits);
}

function bindRange(id, apply, digits = 2) {
  const el = $(id);
  if (!el) return;
  el.oninput = () => {
    const v = Number(el.value);
    const out = $(id + '-val');
    if (out) out.textContent = digits === 0 ? String(Math.round(v)) : v.toFixed(digits);
    apply(v);
  };
}

/** 用当前设置把整组控件画一遍（绑定后、或者外部改了设置时调用） */
export function fillLive2DSettings() {
  const c = cfg();
  setRange('l2d-fit', c.fit, 2);
  setRange('l2d-offset', c.offsetY, 2);
  setRange('l2d-gain', c.lipsyncGain, 2);
  setRange('l2d-idle-interval', c.idleInterval, 0);
  setSeg('l2d-lipsync', c.lipsync ? 'on' : 'off');
  setSeg('l2d-idle', c.idleMotion ? 'on' : 'off');
  setSeg('l2d-focus', c.focusFollow ? 'on' : 'off');
  setSeg('l2d-physics', c.physics ? 'on' : 'off');
  setSeg('l2d-quality', c.quality);
  setSeg('l2d-fps', String(c.fps));
  setSeg('l2d-lod', c.lod);
  setSeg('l2d-mask', c.mask);
  // 关掉口型/待机时，把子参数调暗，避免「动了没反应」的错觉
  const dim = (id, on) => { const box = $(id); if (box) box.classList.toggle('is-muted', !on); };
  dim('l2d-gain-row', !!c.lipsync);
  dim('l2d-idle-row', !!c.idleMotion);
}

export function bindLive2DSettings() {
  if (!$('l2d-fit')) return; // 这一版页面里没有这组控件（旧页面）就静默跳过
  bindRange('l2d-fit', (v) => {
    const c = cfg();
    // fit × zoom 的上限是 1.25：先把 zoom 收进来，避免「拉满却不再变大」的困惑
    const zoom = Math.min(c.zoom, 1.25 / Math.max(0.3, v));
    patchLive2D({ fit: v, zoom: Number(zoom.toFixed(2)) });
  });
  bindRange('l2d-offset', (v) => patchLive2D({ offsetY: v }));
  bindRange('l2d-gain', (v) => patchLive2D({ lipsyncGain: v }));
  bindRange('l2d-idle-interval', (v) => patchLive2D({ idleInterval: Math.round(v) }), 0);

  bindSeg('l2d-lipsync', (v) => {
    patchLive2D({ lipsync: v === 'on' });
    fillLive2DSettings();
  });
  bindSeg('l2d-idle', (v) => {
    patchLive2D({ idleMotion: v === 'on' });
    fillLive2DSettings();
  });
  bindSeg('l2d-focus', (v) => patchLive2D({ focusFollow: v === 'on' }));
  bindSeg('l2d-physics', (v) => patchLive2D({ physics: v === 'on' }));
  bindSeg('l2d-quality', (v) => patchLive2D({ quality: v }));
  bindSeg('l2d-fps', (v) => patchLive2D({ fps: Number(v) }));
  bindSeg('l2d-lod', (v) => patchLive2D({ lod: v }));
  bindSeg('l2d-mask', (v) => patchLive2D({ mask: v }));

  const reset = $('l2d-reset');
  if (reset) {
    reset.onclick = () => {
      patchLive2D(Object.assign({}, DEFAULTS), { immediate: true });
      fillLive2DSettings();
      toast(t('stage.fineReset'));
    };
  }
  fillLive2DSettings();
}

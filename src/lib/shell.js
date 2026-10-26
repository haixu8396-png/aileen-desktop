// ============================================================
// 应用外壳：页面路由、外观主题、弹出菜单、侧栏与状态
//
// 这一层只做「界面骨架」的事，不碰业务：不读设置里的业务字段，
// 不直接调 IPC（除了外壳自己的显示偏好），业务由 main.js / pages.js 装配。
// ============================================================
import { getSettings, saveSettings, setSettingsCache } from './settings.js';
import { $, toast } from './dom.js';
import { applyIcons } from './icons.js';
import { t } from './i18n.js';

let current = 'chat';
/** 页面切换回调：main.js 用它按需刷新页面数据 */
const pageHooks = {};

/** 注册「进入某页时要做的事」 */
export function onPageEnter(name, fn) {
  pageHooks[name] = fn;
}

export function currentPage() {
  return current;
}

/** 切到某个主页面（chat / characters / memory / tasks / devices / settings / char-edit） */
export function gotoPage(name, opts = {}) {
  if (!name) return false;
  const target = $('page-' + name);
  if (!target) return false;
  if (current !== name) {
    document.querySelectorAll('#content .page').forEach((p) => p.classList.toggle('on', p === target));
    document.querySelectorAll('#side-nav .nav-item').forEach((b) => {
      b.classList.toggle('on', b.dataset.page === name);
    });
    // 设置页在导航里是「底部固定项」，不在 side-nav 里
    const bottom = $('btn-settings-menu');
    if (bottom) bottom.classList.toggle('on', name === 'settings');
    current = name;
  }
  if (typeof pageHooks[name] === 'function') {
    try { pageHooks[name](opts); } catch (err) { console.warn('[shell] 页面刷新失败 ' + name, err && err.message); }
  }
  return true;
}

/** 打开设置中心并定位到某个分类 */
export function gotoSettings(sec) {
  gotoPage('settings');
  if (sec) setSettingsSection(sec);
}

export function setSettingsSection(sec) {
  const sections = document.querySelectorAll('#settings-body .set-sec');
  if (!sections.length) return false;
  let hit = null;
  sections.forEach((s) => {
    const on = s.id === 'set-' + sec;
    s.classList.toggle('on', on);
    if (on) hit = s;
  });
  if (!hit) return false;
  document.querySelectorAll('#settings-nav button').forEach((b) => {
    b.classList.toggle('on', b.dataset.sec === sec);
  });
  const body = $('settings-body');
  if (body) body.scrollTop = 0;
  return true;
}

export function currentSettingsSection() {
  const on = document.querySelector('#settings-nav button.on');
  return (on && on.dataset.sec) || 'appearance';
}

// ---------------- 外观 ----------------
function systemDark() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch { return false; }
}

function resolveMode(mode) {
  if (mode === 'dark' || mode === 'light') return mode;
  return systemDark() ? 'dark' : 'light';
}

const ACCENTS = {
  rose: { primary: '#c87898', secondary: '#a99ac7', label: 'accent.rose' },
  sage: { primary: '#7e9c8d', secondary: '#c8a06a', label: 'accent.sage' },
  lavender: { primary: '#9a8ab9', secondary: '#c87898', label: 'accent.lavender' },
  amber: { primary: '#b98b52', secondary: '#9a8ab9', label: 'accent.amber' },
};

export function accentList() {
  return Object.keys(ACCENTS).map((id) => ({ id, ...ACCENTS[id] }));
}

/** 把外观设置写进 <html>：主题模式 / 强调色 / 减少动效 */
export function applyAppearance(app = {}) {
  const mode = app.mode || 'light';
  const theme = resolveMode(mode);
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  // custom 不是预设之一：它靠行内 --accent 覆盖，data-accent 退回 rose 当底
  const accent = app.accent === 'custom' ? 'custom' : (ACCENTS[app.accent] ? app.accent : 'rose');
  root.setAttribute('data-accent', accent === 'custom' ? 'rose' : accent);
  root.setAttribute('data-reduce-motion', app.reduceMotion ? 'true' : 'false');
  // 预设强调色由 data-accent 决定；只有「自定义」才用行内 --accent 覆盖
  const custom = app.custom || null;
  const useCustom = accent === 'custom' && custom && custom.primary;
  if (useCustom) root.style.setProperty('--accent', custom.primary);
  else root.style.removeProperty('--accent');
  if (useCustom && custom.secondary) root.style.setProperty('--accent-vivid', custom.secondary);
  else root.style.removeProperty('--accent-vivid');
  // 自绘标题栏：把系统按钮区的底色/符号色也换成当前主题的（只对 Windows 生效）
  try {
    const cs = getComputedStyle(root);
    const surface = cs.getPropertyValue('--surface').trim() || '#f6f3f0';
    const text = cs.getPropertyValue('--text-primary').trim() || '#39333a';
    if (window.api && typeof window.api.setWindowChrome === 'function') {
      window.api.setWindowChrome({ color: surface, symbolColor: text });
    }
  } catch (err) { /* 老环境没有 titleBarOverlay，忽略 */ }
  return theme;
}

export function bindAppearanceControls() {
  const root = document.documentElement;
  const modeBox = $('theme-mode-switch');
  const syncMode = () => {
    const mode = (getSettings().appearance && getSettings().appearance.mode) || 'light';
    if (modeBox) modeBox.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  };
  if (modeBox) {
    modeBox.querySelectorAll('button').forEach((b) => {
      b.onclick = async () => {
        const s = getSettings();
        const next = Object.assign({}, s, {
          appearance: Object.assign({}, s.appearance, { mode: b.dataset.mode }),
        });
        // 先切缓存再落盘：颜色/模式这类「点一下就该变」的东西不能等 IPC
        setSettingsCache(next);
        applyAppearance(next.appearance);
        syncMode();
        await saveSettings(next);
      };
    });
  }
  const rm = $('s-reduce-motion');
  if (rm) {
    rm.checked = !!(getSettings().appearance && getSettings().appearance.reduceMotion);
    rm.onchange = async () => {
      const s = getSettings();
      const next = Object.assign({}, s, {
        appearance: Object.assign({}, s.appearance, { reduceMotion: !!rm.checked }),
      });
      setSettingsCache(next);
      applyAppearance(next.appearance);
      await saveSettings(next);
    };
  }
  // 时间感知（设置 → 外观与常规）：让角色知道现在几点
  const ta = $('s-time-awareness');
  if (ta) {
    ta.checked = !(getSettings().general && getSettings().general.timeAwareness === false);
    ta.onchange = async () => {
      const s = getSettings();
      const next = Object.assign({}, s, {
        general: Object.assign({}, s.general, { timeAwareness: !!ta.checked }),
      });
      setSettingsCache(next);
      await saveSettings(next);
      toast(ta.checked ? t('general.timeOn') : t('general.timeOff'));
    };
  }
  // 跟随系统时，系统主题变了要跟着变
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onSys = () => {
      const mode = (getSettings().appearance && getSettings().appearance.mode) || 'light';
      if (mode === 'system') applyAppearance(getSettings().appearance);
    };
    if (mq.addEventListener) mq.addEventListener('change', onSys);
    else if (mq.addListener) mq.addListener(onSys);
  } catch (err) { /* 老环境没有 matchMedia 就固定浅色 */ }
  syncMode();
  root.setAttribute('data-reduce-motion', getSettings().appearance && getSettings().appearance.reduceMotion ? 'true' : 'false');
}

// ---------------- 侧栏 ----------------
export function initSidebar() {
  const app = $('app');
  const KEY = 'aileen.ui.sideCollapsed';
  const apply = (collapsed) => {
    if (app) app.classList.toggle('side-collapsed', collapsed);
    if (app) app.classList.toggle('side-open', !collapsed);
    const btn = $('btn-collapse-sidebar');
    if (btn) btn.setAttribute('title', collapsed ? t('sidebar.expand') : t('sidebar.collapse'));
  };
  apply(localStorage.getItem(KEY) === '1');
  const btn = $('btn-collapse-sidebar');
  if (btn) {
    btn.onclick = () => {
      const next = !(app && app.classList.contains('side-collapsed'));
      localStorage.setItem(KEY, next ? '1' : '0');
      apply(next);
    };
  }
  document.querySelectorAll('#side-nav .nav-item').forEach((b) => {
    b.onclick = () => gotoPage(b.dataset.page);
  });
  const settingsBtn = $('btn-settings-menu');
  if (settingsBtn) settingsBtn.onclick = () => gotoSettings();
}

/** 左下角状态行：模型是否可用、是否在跑任务 */
export function setSidebarStatus(text, tone) {
  const tEl = $('side-status-text');
  const dot = $('side-status-dot');
  if (tEl) tEl.textContent = text;
  if (dot) dot.className = 'status-dot' + (tone === 'off' ? ' off' : tone === 'warn' ? ' warn' : tone === 'err' ? ' err' : '');
}

// ---------------- 弹出菜单 ----------------
let openPop = null;

/** 在锚点元素下方/上方打开一个 pop-menu，自动避开窗口边缘 */
export function openPopup(menuId, anchor, opts = {}) {
  const menu = $(menuId);
  if (!menu) return false;
  closePopups();
  menu.classList.remove('hidden');
  const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
  const mw = menu.offsetWidth || 200;
  const mh = menu.offsetHeight || 200;
  let left = r ? r.right - mw : (window.innerWidth - mw) / 2;
  let top = r ? r.bottom + 6 : 80;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (left < 8) left = 8;
  if (top + mh > window.innerHeight - 8 && r) top = Math.max(8, r.top - mh - 6);
  menu.style.left = Math.round(left) + 'px';
  menu.style.top = Math.round(top) + 'px';
  openPop = menu;
  applyIcons(menu);
  return true;
}

export function closePopups() {
  document.querySelectorAll('.pop-menu').forEach((m) => m.classList.add('hidden'));
  openPop = null;
}

export function initPopups() {
  document.addEventListener('click', (e) => {
    if (e.target.closest('.pop-menu')) return;
    if (e.target.closest('#btn-char-actions') || e.target.closest('.ci-more') || e.target.closest('.cc-more')) return;
    closePopups();
  });
  window.addEventListener('resize', closePopups);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePopups();
  });
}

// ---------------- 通用小工具 ----------------
/** 首字头像：没有图片、加载失败都退化成一个字，不出现破图图标。
 *  容器用 span/div（不是 img）—— img 里塞文字是画不出来的。 */
export function fillAvatar(el, name, url) {
  if (!el) return;
  const initials = String(name || 'A').trim().slice(0, 1).toUpperCase() || 'A';
  el.classList.add('avatar');
  el.textContent = '';
  const src = String(url || '').trim();
  if (!src) { el.textContent = initials; return; }
  const img = document.createElement('img');
  img.alt = '';
  img.onerror = () => { if (img.parentNode) img.remove(); el.textContent = initials; };
  img.src = src;
  el.appendChild(img);
}

/** 「已保存」轻提示：在设置区块里闪一下 */
export function flashSaved(rootEl) {
  if (!rootEl) return;
  const hint = rootEl.querySelector('.saved-hint');
  if (!hint) return;
  hint.classList.add('show');
  clearTimeout(hint.__t);
  hint.__t = setTimeout(() => hint.classList.remove('show'), 1600);
}

export function setNavTaskCount(n) {
  const el = $('nav-task-count');
  if (!el) return;
  const count = Number(n) || 0;
  el.textContent = String(count);
  el.classList.toggle('hidden', count <= 0);
}

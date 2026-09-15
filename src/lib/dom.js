// 通用 DOM / 交互工具
import { getSettings } from './settings.js';
import { state } from './state.js';

export const $ = (id) => document.getElementById(id);

export function toast(text, isError) {
  const el = $('toast');
  if (!el) return;
  el.textContent = text;
  el.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast hidden'; }, isError ? 5000 : 2600);
}

export function scrollBottom() {
  const box = $('messages');
  if (!box) return;
  const s = getSettings();
  if (s && s.behavior && s.behavior.autoScroll) {
    box.scrollTop = box.scrollHeight;
  }
  const sb = $('btn-scroll-down');
  if (sb) {
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    sb.classList.toggle('hidden', nearBottom);
  }
}

export function avatarUrl(rel) {
  if (!rel) return '';
  if (/^(https?:|data:)/.test(rel)) return rel;
  const info = state.appInfo || {};
  return (info.modelBaseUrl || '') + '/' + rel.replace(/^\/+/, '');
}

export function autoGrowInput() {
  const el = $('input');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

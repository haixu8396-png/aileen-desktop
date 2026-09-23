// ============================================================
// 设置类弹窗控制器：对话/TTS/STT 设置、外观调色、屏幕视觉、设置菜单
// ============================================================
import { getSettings, saveSettings } from './settings.js';
import { state, presetLlmBase } from './state.js';
import { $, toast } from './dom.js';
import { escapeHtml } from './markdown.js';
import { t } from './i18n.js';

// ---------------- 对话设置 ----------------
export function openLlmModal() {
  const s = getSettings();
  const prov = s.llm.provider;
  $('s-llm-provider').value = prov;
  const custom = !!s.llm.customBaseUrl || prov === 'custom';
  $('s-llm-custom-url').checked = custom;
  $('wrap-llm-base').classList.toggle('hidden', !custom);
  $('s-llm-base').value = s.llm.baseUrl || presetLlmBase(prov);
  $('s-llm-key').value = s.llm.apiKey || '';
  $('s-llm-model').value = s.llm.model || '';
  $('s-llm-temp').value = s.llm.temperature ?? 0.8;
  $('s-llm-max').value = s.llm.maxTokens ?? 1024;
  $('modal-llm').classList.remove('hidden');
}

export function saveLlmModal() {
  const s = getSettings();
  const provider = $('s-llm-provider').value;
  const custom = $('s-llm-custom-url').checked;
  const next = { ...s };
  next.llm = {
    provider,
    customBaseUrl: custom,
    baseUrl: custom ? $('s-llm-base').value.trim() : presetLlmBase(provider),
    apiKey: $('s-llm-key').value.trim(),
    model: $('s-llm-model').value.trim(),
    temperature: parseFloat($('s-llm-temp').value) || 0.8,
    maxTokens: parseInt($('s-llm-max').value, 10) || 1024,
  };
  saveSettings(next).then(() => {
    toast(t('llm.saved'));
    closeSubModal('modal-llm');
  });
}

// ---------------- TTS 设置 ----------------
export function openTtsModal() {
  const s = getSettings();
  $('s-tts-provider').value = s.tts.provider || 'web';
  $('s-tts-language').value = s.tts.language || 'zh';
  const isOpenai = $('s-tts-provider').value === 'openai';
  $('wrap-tts-custom').classList.toggle('hidden', !isOpenai);
  const custom = !!s.tts.customBaseUrl;
  $('s-tts-custom-url').checked = custom;
  $('wrap-tts-base').classList.toggle('hidden', !(isOpenai && custom));
  $('s-tts-base').value = s.tts.baseUrl || 'https://api.openai.com/v1';
  $('s-tts-key').value = s.tts.apiKey || '';
  $('s-tts-model').value = s.tts.model || '';
  $('s-tts-voice').value = s.tts.voice || '';
  $('s-tts-rate').value = String(s.tts.rate ?? 1);
  $('s-tts-rate-val').textContent = Number(s.tts.rate ?? 1).toFixed(1) + '×';
  $('s-tts-auto').checked = !!s.tts.autoPlay;
  $('modal-tts').classList.remove('hidden');
}

export function saveTtsModal() {
  const s = getSettings();
  const provider = $('s-tts-provider').value;
  const custom = provider === 'openai' && $('s-tts-custom-url').checked;
  const next = { ...s };
  next.tts = {
    provider,
    language: $('s-tts-language').value,
    customBaseUrl: custom,
    baseUrl: custom ? $('s-tts-base').value.trim() : 'https://api.openai.com/v1',
    apiKey: $('s-tts-key').value.trim(),
    model: $('s-tts-model').value.trim(),
    voice: $('s-tts-voice').value.trim(),
    rate: parseFloat($('s-tts-rate').value) || 1,
    autoPlay: $('s-tts-auto').checked,
  };
  saveSettings(next).then(() => {
    toast(t('tts.saved'));
    closeSubModal('modal-tts');
  });
}

// ---------------- STT 设置 ----------------
export function openSttModal() {
  const s = getSettings();
  $('s-stt-provider').value = s.stt.provider || 'openai';
  $('s-stt-language').value = s.stt.language || 'zh';
  const isOpenai = $('s-stt-provider').value === 'openai';
  $('wrap-stt-custom').classList.toggle('hidden', !isOpenai);
  const custom = !!s.stt.customBaseUrl;
  $('s-stt-custom-url').checked = custom;
  $('wrap-stt-base').classList.toggle('hidden', !(isOpenai && custom));
  $('s-stt-base').value = s.stt.baseUrl || 'https://api.openai.com/v1';
  $('s-stt-key').value = s.stt.apiKey || '';
  $('s-stt-model').value = s.stt.model || '';
  $('modal-stt').classList.remove('hidden');
}

export function saveSttModal() {
  const s = getSettings();
  const provider = $('s-stt-provider').value;
  const custom = provider === 'openai' && $('s-stt-custom-url').checked;
  const next = { ...s };
  next.stt = {
    provider,
    language: $('s-stt-language').value,
    customBaseUrl: custom,
    baseUrl: custom ? $('s-stt-base').value.trim() : 'https://api.openai.com/v1',
    apiKey: $('s-stt-key').value.trim(),
    model: $('s-stt-model').value.trim(),
  };
  saveSettings(next).then(() => {
    toast(t('stt.saved'));
    closeSubModal('modal-stt');
  });
}

// ---------------- 设置菜单导航 ----------------
// 从设置菜单打开子页面时记住来源，关闭子页面后回到菜单，而不是直接甩回聊天界面。
let openedFromMenu = false;

export function openSettingsMenu() {
  refreshMenuSubtitles();
  openedFromMenu = false;
  $('modal-menu').classList.remove('hidden');
}

/**
 * 从设置菜单打开子页面。
 * 必须调用各页面自己的 open 函数（回填表单 / 建立主题快照 / 刷新模型列表），
 * 只把弹窗 remove('hidden') 是不够的 —— 那会导致表单空白、主题「取消」回滚失效。
 */
export function openFromMenu(targetId, opener) {
  $('modal-menu').classList.add('hidden');
  openedFromMenu = true;
  if (typeof opener === 'function') opener();
  else $(targetId).classList.remove('hidden');
}

/** 关闭子弹窗；若它是由设置菜单打开的，则退回设置菜单 */
export function closeSubModal(id) {
  if (id === 'modal-theme') cancelThemePreview();
  $(id).classList.add('hidden');
  if (openedFromMenu) {
    openedFromMenu = false;
    refreshMenuSubtitles();
    $('modal-menu').classList.remove('hidden');
  }
}

// ---------------- 设置菜单副标题 ----------------
/** 副标题：元素不存在时静默跳过（菜单结构改动不该让整个菜单炸掉） */
function sub(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

export function refreshMenuSubtitles() {
  const s = getSettings();
  const llm = s.llm;
  const prov = s.llm.provider === 'custom' ? t('provider.custom') : t('provider.' + (llm.provider || 'custom'));
  sub('menu-sub-llm', prov + ' · ' + (llm.model || '—'));
  const ttsLabel = t('tts.provider.' + (s.tts.provider || 'web'));
  sub('menu-sub-tts', ttsLabel + ' · ' + String(s.tts.language || 'zh').toUpperCase());
  const sttLabel = t('stt.provider.' + (s.stt.provider || 'openai'));
  sub('menu-sub-stt', sttLabel + ' · ' + String(s.stt.language || 'zh').toUpperCase());
  sub('menu-sub-model', state.models.length ? t('menu.subModels', { n: state.models.length }) : t('menu.subNoModels'));
  sub('menu-sub-theme', ((s.theme && s.theme.primary) || '#ff7eb3'));
}

/** 供其他模块写入菜单副标题（如无边框展台开关状态） */
export function setMenuSub(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

// ---------------- 获取模型 / 音色列表 ----------------
export function fillDatalist(id, items) {
  const dl = $(id);
  if (dl) dl.innerHTML = items.map((x) => '<option value="' + escapeHtml(String(x)) + '"></option>').join('');
}

function effectiveLlmBase() {
  const custom = $('s-llm-custom-url').checked;
  return custom ? $('s-llm-base').value.trim() : presetLlmBase($('s-llm-provider').value);
}

export async function fetchLlmModels() {
  const baseUrl = effectiveLlmBase();
  const apiKey = $('s-llm-key').value.trim();
  if (!baseUrl) { toast(t('llm.needBaseUrl'), true); return; }
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/models', { headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const ids = (j.data || []).map((m) => m.id || m).filter(Boolean);
    if (!ids.length) throw new Error('no models');
    fillDatalist('dl-llm-models', ids);
    toast(t('llm.fetched', { n: ids.length }));
  } catch (err) {
    toast(t('llm.fetchFailed', { msg: (err && err.message ? err.message : err) }), true);
  }
}

export async function testLlmConnection() {
  const baseUrl = effectiveLlmBase();
  const apiKey = $('s-llm-key').value.trim();
  if (!baseUrl) { toast(t('llm.missingBaseUrl'), true); return; }
  toast(t('llm.testing'));
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/models', { headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    toast(t('llm.testOk'));
  } catch (err) {
    toast(t('llm.testFailed', { msg: (err && err.message ? err.message : err) }), true);
  }
}

export async function fetchTtsVoices() {
  const provider = $('s-tts-provider').value;
  const apiKey = $('s-tts-key').value.trim();
  if (provider === 'web') {
    const voices = window.speechSynthesis.getVoices();
    if (voices.length) { fillDatalist('dl-tts-voices', voices.map((v) => v.name)); toast(t('tts.voicesLoaded')); return; }
    toast(t('tts.noVoices'), true);
    return;
  }
  if (provider === 'fish') {
    if (!apiKey) { toast(t('tts.needFishKey'), true); return; }
    try {
      const res = await fetch('https://api.fish.audio/v1/voices', { headers: { Authorization: 'Bearer ' + apiKey } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const items = (j.data || j.voices || []).map((v) => (v._id || v.id || '') + ' · ' + (v.title || v.name || '')).filter(Boolean);
      if (!items.length) throw new Error('账号下没有可用音色');
      fillDatalist('dl-tts-voices', items);
      toast(t('tts.gotVoices', { n: items.length }));
    } catch (err) {
      toast(t('tts.voiceFailed', { msg: (err && err.message ? err.message : err) }), true);
    }
    return;
  }
  if (provider === 'xiaomi') {
    fillDatalist('dl-tts-voices', ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean']);
    toast(t('tts.builtinXiaomi'));
    return;
  }
  if (provider === 'openai') {
    fillDatalist('dl-tts-voices', ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
    toast(t('tts.builtinOpenai'));
    return;
  }
}

export async function fetchSttModels() {
  const provider = $('s-stt-provider').value;
  if (provider === 'xiaomi') { fillDatalist('dl-stt-models', ['mimo-v2.5-asr']); toast(t('stt.builtinXiaomi')); return; }
  if (provider === 'web') { toast(t('stt.webNoModel')); return; }
  const custom = $('s-stt-custom-url').checked;
  const baseUrl = custom ? $('s-stt-base').value.trim() : 'https://api.openai.com/v1';
  const apiKey = $('s-stt-key').value.trim();
  if (!baseUrl) { toast(t('llm.needBaseUrl'), true); return; }
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/models', { headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const ids = (j.data || []).map((m) => m.id || m).filter(Boolean);
    if (!ids.length) throw new Error('no models');
    fillDatalist('dl-stt-models', ids);
    toast(t('stt.gotModels', { n: ids.length }));
  } catch (err) {
    toast(t('llm.fetchFailed', { msg: (err && err.message ? err.message : err) }), true);
  }
}

// ---------------- 外观调色 ----------------
export const THEME_PRESETS = [
  { key: 'theme.preset.aileen', primary: '#ff7eb3', secondary: '#38b0de' },
  { key: 'theme.preset.sky', primary: '#38b0de', secondary: '#7c9bff' },
  { key: 'theme.preset.mint', primary: '#4ecdc4', secondary: '#a8e6a3' },
  { key: 'theme.preset.night', primary: '#a78bfa', secondary: '#f472b6' },
  { key: 'theme.preset.lava', primary: '#ff8c5a', secondary: '#ffd166' },
  { key: 'theme.preset.peach', primary: '#ff6f91', secondary: '#ffc75f' },
];

export function applyTheme(t) {
  const theme = t || {};
  const root = document.documentElement;
  root.style.setProperty('--accent', theme.primary || '#ff7eb3');
  root.style.setProperty('--accent2', theme.secondary || '#38b0de');
}

export function renderThemePresets() {
  const box = $('theme-presets');
  if (!box) return;
  box.innerHTML = '';
  for (const pre of THEME_PRESETS) {
    const sw = document.createElement('div');
    sw.className = 'theme-swatch';
    sw.dataset.primary = pre.primary;
    sw.dataset.secondary = pre.secondary;
    sw.style.background = 'linear-gradient(135deg, ' + pre.primary + ', ' + pre.secondary + ')';
    const pname = t(pre.key);
    sw.textContent = pname;
    sw.title = t('theme.previewTip', { name: pname });
    sw.onclick = () => {
      $('t-primary').value = pre.primary;
      $('t-secondary').value = pre.secondary;
      applyTheme(pre);
      markActivePreset();
    };
    box.appendChild(sw);
  }
}

/** 高亮与当前所选颜色一致的预设色块 */
export function markActivePreset() {
  const p = $('t-primary');
  const s2 = $('t-secondary');
  if (!p || !s2) return;
  const cur = (p.value || '').toLowerCase() + '|' + (s2.value || '').toLowerCase();
  document.querySelectorAll('.theme-swatch').forEach((x) => {
    x.classList.toggle('on', (x.dataset.primary + '|' + x.dataset.secondary) === cur);
  });
}

// 主题是「即时预览」的，所以打开时先记下原配色；取消/Esc/点遮罩时还原，
// 否则用户点了预览又取消，界面颜色变了但设置没存，重启后又变回去（旧版 bug）。
let themeSnapshot = null;

function cancelThemePreview() {
  if (!themeSnapshot) return;
  applyTheme(themeSnapshot);
  themeSnapshot = null;
  const t = getSettings().theme || {};
  if ($('t-primary')) $('t-primary').value = t.primary || '#ff7eb3';
  if ($('t-secondary')) $('t-secondary').value = t.secondary || '#38b0de';
  markActivePreset();
}

export function openThemeModal() {
  const t = getSettings().theme || {};
  themeSnapshot = { primary: t.primary || '#ff7eb3', secondary: t.secondary || '#38b0de' };
  $('t-primary').value = themeSnapshot.primary;
  $('t-secondary').value = themeSnapshot.secondary;
  renderThemePresets();
  markActivePreset();
  $('modal-theme').classList.remove('hidden');
}

export function saveThemeModal() {
  const next = { ...getSettings() };
  next.theme = {
    primary: $('t-primary').value,
    secondary: $('t-secondary').value,
  };
  saveSettings(next).then(() => {
    themeSnapshot = null; // 已保存，取消时不再还原
    applyTheme(getSettings().theme);
    toast(t('theme.saved'));
    closeSubModal('modal-theme');
  });
}

// ---------------- 屏幕视觉（截图发给角色） ----------------
export function setAttachUI() {
  const bar = $('attach-bar');
  if (state.pendingImage) {
    $('attach-preview').src = state.pendingImage.dataURL;
    $('attach-name').textContent = state.pendingImage.name;
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
  }
}

export async function openScreenPicker() {
  toast(t('screen.capturing'));
  const res = await window.api.captureScreen();
  if (!res) return;
  if (res.error) { toast(t('screen.captureFailed', { msg: res.error }), true); return; }
  const grid = $('screen-grid');
  grid.innerHTML = '';
  if (!res.length) {
    grid.innerHTML = '<div class="empty">' + t('screen.empty') + '</div>';
    $('modal-screen').classList.remove('hidden');
    return;
  }
  for (const src of res) {
    const item = document.createElement('div');
    item.className = 'screen-item';
    const img = document.createElement('img');
    img.src = src.thumbnail;
    const span = document.createElement('span');
    span.textContent = src.name;
    item.appendChild(img);
    item.appendChild(span);
    item.onclick = () => {
      state.pendingImage = { dataURL: src.thumbnail, name: src.name };
      setAttachUI();
      $('modal-screen').classList.add('hidden');
      toast(t('chat.attached'));
    };
    grid.appendChild(item);
  }
  $('modal-screen').classList.remove('hidden');
}

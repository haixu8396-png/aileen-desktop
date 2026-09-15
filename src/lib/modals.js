// ============================================================
// 设置类弹窗控制器：对话/TTS/STT 设置、外观调色、屏幕视觉、设置菜单
// ============================================================
import { getSettings, saveSettings } from './settings.js';
import { state, presetLlmBase } from './state.js';
import { $, toast } from './dom.js';
import { escapeHtml } from './markdown.js';

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
    toast('对话设置已保存');
    $('modal-llm').classList.add('hidden');
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
    toast('TTS 设置已保存');
    $('modal-tts').classList.add('hidden');
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
    toast('STT 设置已保存');
    $('modal-stt').classList.add('hidden');
  });
}

// ---------------- 设置菜单副标题 ----------------
export function refreshMenuSubtitles() {
  const s = getSettings();
  const llm = s.llm;
  const prov = s.llm.provider === 'custom' ? '自定义' : (llm.provider || '自定义');
  $('menu-sub-llm').textContent = prov + ' · ' + (llm.model || '未设置模型');
  const ttsLabel = { web: '系统语音', openai: 'OpenAI 兼容', fish: 'Fish Audio', xiaomi: '小米 MiMo' }[s.tts.provider] || '';
  $('menu-sub-tts').textContent = ttsLabel + ' · ' + String(s.tts.language || 'zh').toUpperCase();
  const sttLabel = { openai: 'Whisper 兼容', xiaomi: '小米 ASR', web: '浏览器' }[s.stt.provider] || '';
  $('menu-sub-stt').textContent = sttLabel + ' · ' + String(s.stt.language || 'zh').toUpperCase();
  $('menu-sub-model').textContent = state.models.length ? state.models.length + ' 个模型' : '暂无模型';
  $('menu-sub-theme').textContent = '主色 ' + ((s.theme && s.theme.primary) || '#ff7eb3');
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
  if (!baseUrl) { toast('请先填写接口地址', true); return; }
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/models', { headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const ids = (j.data || []).map((m) => m.id || m).filter(Boolean);
    if (!ids.length) throw new Error('接口未返回模型列表');
    fillDatalist('dl-llm-models', ids);
    toast('获取到 ' + ids.length + ' 个模型，点击输入框即可下拉选择');
  } catch (err) {
    toast('获取模型失败: ' + (err && err.message ? err.message : err), true);
  }
}

export async function testLlmConnection() {
  const baseUrl = effectiveLlmBase();
  const apiKey = $('s-llm-key').value.trim();
  if (!baseUrl) { toast('缺少接口地址', true); return; }
  toast('正在测试连接…');
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/models', { headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    toast('连接成功 ✅');
  } catch (err) {
    toast('连接失败: ' + (err && err.message ? err.message : err), true);
  }
}

export async function fetchTtsVoices() {
  const provider = $('s-tts-provider').value;
  const apiKey = $('s-tts-key').value.trim();
  if (provider === 'web') {
    const voices = window.speechSynthesis.getVoices();
    if (voices.length) { fillDatalist('dl-tts-voices', voices.map((v) => v.name)); toast('已加载系统语音'); return; }
    toast('暂无系统语音', true);
    return;
  }
  if (provider === 'fish') {
    if (!apiKey) { toast('请先填写 Fish Audio API Key', true); return; }
    try {
      const res = await fetch('https://api.fish.audio/v1/voices', { headers: { Authorization: 'Bearer ' + apiKey } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const items = (j.data || j.voices || []).map((v) => (v._id || v.id || '') + ' · ' + (v.title || v.name || '')).filter(Boolean);
      if (!items.length) throw new Error('账号下没有可用音色');
      fillDatalist('dl-tts-voices', items);
      toast('获取到 ' + items.length + ' 个音色');
    } catch (err) {
      toast('获取音色失败: ' + (err && err.message ? err.message : err), true);
    }
    return;
  }
  if (provider === 'xiaomi') {
    fillDatalist('dl-tts-voices', ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean']);
    toast('小米内置音色已填入');
    return;
  }
  if (provider === 'openai') {
    fillDatalist('dl-tts-voices', ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
    toast('OpenAI 内置音色已填入');
    return;
  }
}

export async function fetchSttModels() {
  const provider = $('s-stt-provider').value;
  if (provider === 'xiaomi') { fillDatalist('dl-stt-models', ['mimo-v2.5-asr']); toast('小米 ASR 模型已填入'); return; }
  if (provider === 'web') { toast('浏览器识别无需模型'); return; }
  const custom = $('s-stt-custom-url').checked;
  const baseUrl = custom ? $('s-stt-base').value.trim() : 'https://api.openai.com/v1';
  const apiKey = $('s-stt-key').value.trim();
  if (!baseUrl) { toast('请先填写接口地址', true); return; }
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/models', { headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const ids = (j.data || []).map((m) => m.id || m).filter(Boolean);
    if (!ids.length) throw new Error('接口未返回模型列表');
    fillDatalist('dl-stt-models', ids);
    toast('获取到 ' + ids.length + ' 个模型');
  } catch (err) {
    toast('获取模型失败: ' + (err && err.message ? err.message : err), true);
  }
}

// ---------------- 外观调色 ----------------
export const THEME_PRESETS = [
  { name: 'Elysia 粉', primary: '#ff7eb3', secondary: '#38b0de' },
  { name: '晴空蓝', primary: '#38b0de', secondary: '#7c9bff' },
  { name: '薄荷绿', primary: '#4ecdc4', secondary: '#a8e6a3' },
  { name: '星夜紫', primary: '#a78bfa', secondary: '#f472b6' },
  { name: '熔岩橙', primary: '#ff8c5a', secondary: '#ffd166' },
  { name: '蜜桃甜', primary: '#ff6f91', secondary: '#ffc75f' },
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
    sw.style.background = 'linear-gradient(135deg, ' + pre.primary + ', ' + pre.secondary + ')';
    sw.textContent = pre.name;
    sw.onclick = () => {
      $('t-primary').value = pre.primary;
      $('t-secondary').value = pre.secondary;
      applyTheme(pre);
      document.querySelectorAll('.theme-swatch').forEach((x) => x.classList.remove('on'));
      sw.classList.add('on');
    };
    box.appendChild(sw);
  }
}

export function openThemeModal() {
  const t = getSettings().theme || {};
  $('t-primary').value = t.primary || '#ff7eb3';
  $('t-secondary').value = t.secondary || '#38b0de';
  renderThemePresets();
  $('modal-theme').classList.remove('hidden');
}

export function saveThemeModal() {
  const next = { ...getSettings() };
  next.theme = {
    primary: $('t-primary').value,
    secondary: $('t-secondary').value,
  };
  saveSettings(next).then(() => {
    applyTheme(getSettings().theme);
    toast('外观已保存');
    $('modal-theme').classList.add('hidden');
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
  toast('正在捕获屏幕…');
  const res = await window.api.captureScreen();
  if (!res) return;
  if (res.error) { toast('屏幕捕获失败: ' + res.error, true); return; }
  const grid = $('screen-grid');
  grid.innerHTML = '';
  if (!res.length) {
    grid.innerHTML = '<div class="empty">没有可捕获的画面</div>';
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
      toast('已附加截图，输入问题后发送（需多模态模型）');
    };
    grid.appendChild(item);
  }
  $('modal-screen').classList.remove('hidden');
}

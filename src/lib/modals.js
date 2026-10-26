// ============================================================
// 设置中心：表单回填、保存、连接测试、主题与屏幕截图
//
// 旧版是「一个设置一个弹窗」，十来个风格相同但彼此割裂的弹窗。
// 现在所有字段都住在 #page-settings 的 9 个分类里，这里只负责：
//   · 打开分类时按真实设置回填（fill*）
//   · 保存时组装 payload（save*），保存后留在原地并闪一下「已保存」
//   · 取模型 / 测连接 / 屏幕截图这些短任务
// 字段 id 全部沿用旧名，业务逻辑（payload 形状、密钥语义）没有改。
// ============================================================
import { getSettings, saveSettings, hasApiKey, setSettingsCache } from './settings.js';
import { state, presetLlmBase, presetEmbeddingBase, presetEmbeddingModel } from './state.js';
import { $, toast } from './dom.js';
import { escapeHtml } from './markdown.js';
import { t } from './i18n.js';
import { accentList, applyAppearance, flashSaved, gotoSettings } from './shell.js';

// ---------------- API Key 字段 ----------------
//
// 渲染层拿不到明文密钥，所以输入框平时是掩码；三种状态都要能表达：
//   · 掩码不动 → 不改；填新值 → 覆盖；清空 → 删除（否则用户没法撤销配错的 Key）
const KEY_MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';

function setKeyField(id, group) {
  const el = $(id);
  if (!el) return;
  const configured = hasApiKey(group);
  el.value = configured ? KEY_MASK : '';
  el.placeholder = configured ? t('llm.keyKeepHint') : 'sk-…';
  const hintId = id.replace(/^s-/, '').replace(/-key$/, '-key-state');
  const hint = $(hintId);
  if (hint) {
    hint.textContent = configured ? t('settings.keyConfigured') : t('settings.keyMissing');
    hint.style.color = configured ? 'var(--sage)' : 'var(--text-tertiary)';
  }
}

function typedKey(id) {
  const el = $(id);
  const v = el ? el.value.trim() : '';
  return (!v || v === KEY_MASK) ? '' : v;
}

function keyPatch(id, group) {
  const el = $(id);
  const v = el ? el.value.trim() : '';
  if (v === KEY_MASK) return '';
  if (v === '') return hasApiKey(group) ? window.api.SECRET_CLEAR : '';
  return v;
}

function errText(err) {
  return String((err && err.message) ? err.message : err);
}

function sectionOf(id) {
  const el = $(id);
  return el ? el.closest('.set-sec') : null;
}

function saved(id, key) {
  toast(t(key));
  flashSaved(sectionOf(id));
}

// ---------------- 对话模型 ----------------
export function fillLlm() {
  const s = getSettings();
  const prov = s.llm.provider;
  $('s-llm-provider').value = prov;
  const custom = !!s.llm.customBaseUrl || prov === 'custom';
  $('s-llm-custom-url').checked = custom;
  $('wrap-llm-base').classList.toggle('hidden', !custom);
  $('s-llm-base').value = s.llm.baseUrl || presetLlmBase(prov);
  setKeyField('s-llm-key', 'llm');
  $('s-llm-model').value = s.llm.model || '';
  $('s-llm-temp').value = s.llm.temperature ?? 0.8;
  $('s-llm-max').value = s.llm.maxTokens ?? 1024;
}

export function openLlmModal() {
  fillLlm();
  gotoSettings('models');
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
    apiKey: keyPatch('s-llm-key', 'llm'),
    model: $('s-llm-model').value.trim(),
    temperature: parseFloat($('s-llm-temp').value) || 0.8,
    maxTokens: parseInt($('s-llm-max').value, 10) || 1024,
  };
  return saveSettings(next).then(() => {
    saved('s-llm-save', 'llm.saved');
    setKeyField('s-llm-key', 'llm');
    try { window.dispatchEvent(new CustomEvent('aileen:settings-changed')); } catch (err) { /* ignore */ }
  });
}

// ---------------- TTS ----------------
export function fillTts() {
  const s = getSettings();
  $('s-tts-provider').value = s.tts.provider || 'none';
  $('s-tts-language').value = s.tts.language || 'zh';
  const isOpenai = $('s-tts-provider').value === 'openai';
  $('wrap-tts-custom').classList.toggle('hidden', !isOpenai);
  const custom = !!s.tts.customBaseUrl;
  $('s-tts-custom-url').checked = custom;
  $('wrap-tts-base').classList.toggle('hidden', !(isOpenai && custom));
  $('s-tts-base').value = s.tts.baseUrl || 'https://api.openai.com/v1';
  setKeyField('s-tts-key', 'tts');
  $('s-tts-model').value = s.tts.model || '';
  $('s-tts-voice').value = s.tts.voice || '';
  $('s-tts-rate').value = String(s.tts.rate ?? 1);
  $('s-tts-rate-val').textContent = Number(s.tts.rate ?? 1).toFixed(1) + '×';
  $('s-tts-auto').checked = !!s.tts.autoPlay;
}

export function openTtsModal() {
  fillTts();
  gotoSettings('voice');
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
    apiKey: keyPatch('s-tts-key', 'tts'),
    model: $('s-tts-model').value.trim(),
    voice: $('s-tts-voice').value.trim(),
    rate: parseFloat($('s-tts-rate').value) || 1,
    autoPlay: $('s-tts-auto').checked,
  };
  return saveSettings(next).then(() => {
    saved('s-tts-save', 'tts.saved');
    setKeyField('s-tts-key', 'tts');
  });
}

// ---------------- STT ----------------
export function fillStt() {
  const s = getSettings();
  $('s-stt-provider').value = s.stt.provider || 'none';
  $('s-stt-language').value = s.stt.language || 'zh';
  const isOpenai = $('s-stt-provider').value === 'openai';
  $('wrap-stt-custom').classList.toggle('hidden', !isOpenai);
  const custom = !!s.stt.customBaseUrl;
  $('s-stt-custom-url').checked = custom;
  $('wrap-stt-base').classList.toggle('hidden', !(isOpenai && custom));
  $('s-stt-base').value = s.stt.baseUrl || 'https://api.openai.com/v1';
  setKeyField('s-stt-key', 'stt');
  $('s-stt-model').value = s.stt.model || '';
}

export function openSttModal() {
  fillStt();
  gotoSettings('voice');
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
    apiKey: keyPatch('s-stt-key', 'stt'),
    model: $('s-stt-model').value.trim(),
  };
  return saveSettings(next).then(() => {
    saved('s-stt-save', 'stt.saved');
    setKeyField('s-stt-key', 'stt');
  });
}

// ---------------- 嵌入模型 + 记忆范围 ----------------
export function fillEmbedding() {
  const s = getSettings();
  const e = s.embedding || {};
  const mem = s.memoryCfg || {};
  const know = s.knowledgeCfg || {};
  $('s-embed-enabled').checked = e.enabled !== false;
  $('s-embed-provider').value = e.provider || 'none';
  const custom = !!e.customBaseUrl || e.provider === 'custom';
  $('s-embed-custom-url').checked = custom;
  $('wrap-embed-base').classList.toggle('hidden', !custom);
  $('s-embed-base').value = e.baseUrl || presetEmbeddingBase(e.provider || 'openai');
  setKeyField('s-embed-key', 'embedding');
  $('s-embed-model').value = e.model || presetEmbeddingModel(e.provider || 'openai');
  $('s-mem-perchar').value = mem.perCharacter === false ? 'no' : 'yes';
  $('s-mem-tokens').value = mem.maxContextTokens ?? 800;
  $('s-know-tokens').value = know.maxContextTokens ?? 1200;
}

export function openEmbeddingModal() {
  fillEmbedding();
  gotoSettings('models');
}

function embeddingFormPayload() {
  const custom = $('s-embed-custom-url').checked;
  const provider = $('s-embed-provider').value;
  return {
    baseUrl: (custom ? $('s-embed-base').value.trim() : '') || presetEmbeddingBase(provider),
    model: $('s-embed-model').value.trim(),
    apiKey: typedKey('s-embed-key'),
  };
}

export function saveEmbeddingModal() {
  const s = getSettings();
  const provider = $('s-embed-provider').value;
  const custom = $('s-embed-custom-url').checked || provider === 'custom';
  const next = { ...s };
  next.embedding = {
    enabled: $('s-embed-enabled').checked,
    provider,
    customBaseUrl: custom,
    baseUrl: (custom ? $('s-embed-base').value.trim() : '') || presetEmbeddingBase(provider),
    apiKey: keyPatch('s-embed-key', 'embedding'),
    model: $('s-embed-model').value.trim(),
    batchSize: (s.embedding && s.embedding.batchSize) || 16,
  };
  return saveSettings(next).then(() => {
    saved('s-embed-save', 'embed.saved');
    setKeyField('s-embed-key', 'embedding');
  });
}

/** 记忆范围与预算（与嵌入模型分开保存：它们属于「记忆」而不是「模型连接」） */
export function saveMemoryScope() {
  const s = getSettings();
  const next = { ...s };
  next.memoryCfg = {
    ...(s.memoryCfg || {}),
    perCharacter: $('s-mem-perchar').value === 'yes',
    maxContextTokens: parseInt($('s-mem-tokens').value, 10) || 0,
  };
  next.knowledgeCfg = {
    ...(s.knowledgeCfg || {}),
    maxContextTokens: parseInt($('s-know-tokens').value, 10) || 0,
  };
  return saveSettings(next).then(() => saved('s-mem-save', 'memory.saved'));
}

export async function fetchEmbeddingModels() {
  const btn = $('btn-embed-fetch');
  try {
    if (btn) btn.disabled = true;
    const res = await window.api.embeddingListModels(embeddingFormPayload());
    const list = (res && res.models) || [];
    fillDatalist('dl-embed-models', list);
    const suggested = (res && res.suggested) || [];
    if (!list.length) toast(t('embed.noModels'), true);
    else {
      if (suggested.length && !$('s-embed-model').value.trim()) $('s-embed-model').value = suggested[0];
      toast(t('embed.fetched', { n: list.length }));
    }
  } catch (err) {
    toast(errText(err), true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

export async function testEmbedding() {
  const btn = $('btn-embed-test');
  try {
    if (btn) btn.disabled = true;
    const res = await window.api.embeddingTest(embeddingFormPayload());
    toast(t('embed.testOk', { n: (res && res.dimensions) || '?' }));
  } catch (err) {
    toast(errText(err), true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------------- 聊天状态点 ----------------
export function refreshChatStatus() {
  const dot = $('chat-status');
  if (!dot) return;
  const ok = hasApiKey('llm');
  dot.classList.toggle('off', !ok);
  dot.title = ok ? t('chat.statusReady') : t('chat.statusNoKey');
}

// ---------------- 表演 ----------------
export function fillPerform() {
  const b = getSettings().behavior || {};
  $('p-narration').value = b.narration || 'natural';
  $('p-pacing').value = b.pacing || 'natural';
}

export function openPerformModal() {
  fillPerform();
  gotoSettings('companion');
}

export function savePerformModal() {
  const next = { ...getSettings() };
  next.behavior = {
    ...(next.behavior || {}),
    narration: $('p-narration').value,
    pacing: $('p-pacing').value,
  };
  return saveSettings(next).then(() => saved('p-save', 'perform.saved'));
}

// ---------------- 取模型 / 音色列表 ----------------
export function fillDatalist(id, items) {
  const dl = $(id);
  if (dl) dl.innerHTML = (items || []).map((x) => '<option value="' + escapeHtml(String(x)) + '"></option>').join('');
}

function effectiveLlmBase() {
  const custom = $('s-llm-custom-url').checked;
  return custom ? $('s-llm-base').value.trim() : presetLlmBase($('s-llm-provider').value);
}

export async function fetchLlmModels() {
  const baseUrl = effectiveLlmBase();
  if (!baseUrl) { toast(t('llm.needBaseUrl'), true); return; }
  try {
    const ids = await window.api.llmListModels({ baseUrl, apiKey: typedKey('s-llm-key') });
    fillDatalist('dl-llm-models', ids);
    toast(t('llm.fetched', { n: ids.length }));
  } catch (err) {
    toast(t('llm.fetchFailed', { msg: errText(err) }), true);
  }
}

export async function testLlmConnection() {
  const baseUrl = effectiveLlmBase();
  if (!baseUrl) { toast(t('llm.missingBaseUrl'), true); return; }
  toast(t('llm.testing'));
  try {
    await window.api.llmTest({ baseUrl, apiKey: typedKey('s-llm-key') });
    toast(t('llm.testOk'));
  } catch (err) {
    toast(t('llm.testFailed', { msg: errText(err) }), true);
  }
}

export async function fetchTtsVoices() {
  const provider = $('s-tts-provider').value;
  if (provider === 'web') {
    const voices = window.speechSynthesis.getVoices();
    if (voices.length) { fillDatalist('dl-tts-voices', voices.map((v) => v.name)); toast(t('tts.voicesLoaded')); return; }
    toast(t('tts.noVoices'), true);
    return;
  }
  if (provider === 'fish') {
    try {
      const items = await window.api.ttsListVoices({ apiKey: typedKey('s-tts-key') });
      fillDatalist('dl-tts-voices', items);
      toast(t('tts.gotVoices', { n: items.length }));
    } catch (err) {
      toast(t('tts.voiceFailed', { msg: errText(err) }), true);
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
  }
}

export async function fetchSttModels() {
  const provider = $('s-stt-provider').value;
  if (provider === 'xiaomi') { fillDatalist('dl-stt-models', ['mimo-v2.5-asr']); toast(t('stt.builtinXiaomi')); return; }
  if (provider === 'web') { toast(t('stt.webNoModel')); return; }
  const custom = $('s-stt-custom-url').checked;
  const baseUrl = custom ? $('s-stt-base').value.trim() : 'https://api.openai.com/v1';
  if (!baseUrl) { toast(t('llm.needBaseUrl'), true); return; }
  try {
    const ids = await window.api.sttListModels({ baseUrl, apiKey: typedKey('s-stt-key') });
    fillDatalist('dl-stt-models', ids);
    toast(t('stt.gotModels', { n: ids.length }));
  } catch (err) {
    toast(t('llm.fetchFailed', { msg: errText(err) }), true);
  }
}

// ---------------- 主题（强调色 + 自定义） ----------------
/**
 * 应用强调色。传 { accent: 'rose' } 用预设；传 { primary, secondary } 用自定义。
 * 只改强调色，不动 --app-bg 等结构性令牌 —— 主题模式由 data-theme 决定。
 */
export function applyAccent(patch) {
  const s = getSettings();
  const appearance = Object.assign({}, s.appearance, patch);
  if (patch && patch.primary) appearance.accent = 'custom';
  applyAppearance(appearance);
  return appearance;
}

export function renderThemePresets() {
  const box = $('theme-presets');
  if (!box) return;
  box.innerHTML = '';
  const s = getSettings();
  const appearance = s.appearance || {};
  for (const a of accentList()) {
    const sw = document.createElement('button');
    sw.className = 'theme-swatch' + (appearance.accent === a.id ? ' on' : '');
    sw.dataset.accent = a.id;
    sw.style.background = a.primary;
    sw.title = t(a.label);
    sw.setAttribute('aria-label', t(a.label));
    sw.onclick = async () => {
      const next = { ...getSettings() };
      // 选预设 = 放弃之前的自定义颜色，否则行内 --accent 会一直压着预设
      next.appearance = Object.assign({}, next.appearance, { accent: a.id, custom: null });
      // 先切缓存：否则 renderThemePresets 读到的还是上一档，看起来「慢一拍」
      setSettingsCache(next);
      applyAppearance(next.appearance);
      renderThemePresets();
      await saveSettings(next);
    };
    box.appendChild(sw);
  }
}

export function markActivePreset() { renderThemePresets(); }

let themeSnapshot = null;

function refreshColorInputs() {
  const theme = getSettings().theme || {};
  if ($('t-primary')) $('t-primary').value = theme.primary || '#c87898';
  if ($('t-secondary')) $('t-secondary').value = theme.secondary || '#a99ac7';
}

export function openThemeModal() {
  const appearance = getSettings().appearance || {};
  refreshColorInputs();
  renderThemePresets();
  gotoSettings('appearance');
  // 取消时只还原强调色：主题模式是即时生效的开关，不该被「取消」改回去
  themeSnapshot = { accent: appearance.accent };
}

export function cancelThemePreview() {
  // 不依赖「先打开过设置页」这一前提：直接从已保存的设置重画一次外观，
  // 这样任何路径点「取消」都能把即时预览的颜色收回去。
  applyAppearance(Object.assign({}, getSettings().appearance));
  refreshColorInputs();
  themeSnapshot = null;
}

export function saveThemeModal() {
  const next = { ...getSettings() };
  next.theme = {
    primary: $('t-primary').value,
    secondary: $('t-secondary').value,
  };
  next.appearance = Object.assign({}, next.appearance, {
    accent: 'custom',
    custom: { primary: next.theme.primary, secondary: next.theme.secondary },
  });
  setSettingsCache(next);
  applyAppearance(next.appearance);
  return saveSettings(next).then(() => {
    themeSnapshot = null;
    renderThemePresets();
    saved('t-save', 'theme.saved');
  });
}

export function resetTheme() {
  const next = { ...getSettings() };
  next.theme = { primary: '#c87898', secondary: '#a99ac7' };
  next.appearance = Object.assign({}, next.appearance, { accent: 'rose', custom: null });
  setSettingsCache(next);
  applyAppearance(next.appearance);
  return saveSettings(next).then(() => {
    if ($('t-primary')) $('t-primary').value = next.theme.primary;
    if ($('t-secondary')) $('t-secondary').value = next.theme.secondary;
    renderThemePresets();
    toast(t('theme.resetDone'));
  });
}

// ---------------- 屏幕视觉（截图发给角色） ----------------
export function setAttachUI() {
  const bar = $('attach-bar');
  if (!bar) return;
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

// ---------------- 初始化 ----------------
/** 把所有表单与按钮接起来（只调一次） */
export function initSettingsPage() {
  // 保存
  const bind = (id, fn) => { const el = $(id); if (el) el.onclick = () => fn().catch((err) => toast(errText(err), true)); };
  bind('s-llm-save', saveLlmModal);
  bind('s-tts-save', saveTtsModal);
  bind('s-stt-save', saveSttModal);
  bind('s-embed-save', saveEmbeddingModal);
  bind('s-mem-save', saveMemoryScope);
  bind('p-save', savePerformModal);
  bind('t-save', saveThemeModal);
  bind('s-llm-cancel', () => { fillLlm(); return Promise.resolve(); });
  bind('s-tts-cancel', () => { fillTts(); return Promise.resolve(); });
  bind('s-stt-cancel', () => { fillStt(); return Promise.resolve(); });
  bind('s-embed-cancel', () => { fillEmbedding(); return Promise.resolve(); });
  bind('p-cancel', () => { fillPerform(); return Promise.resolve(); });
  bind('t-cancel', () => { cancelThemePreview(); refreshColorInputs(); return Promise.resolve(); });
  bind('t-reset', resetTheme);

  // 取列表 / 测连接
  const wire = (id, fn) => { const el = $(id); if (el) el.onclick = () => fn().catch((err) => toast(errText(err), true)); };
  wire('btn-llm-fetch', fetchLlmModels);
  wire('btn-llm-test', testLlmConnection);
  wire('btn-tts-fetch', fetchTtsVoices);
  wire('btn-stt-fetch', fetchSttModels);
  wire('btn-embed-fetch', fetchEmbeddingModels);
  wire('btn-embed-test', testEmbedding);

  // 服务商切换：自定义地址字段跟着显隐
  const llmProv = $('s-llm-provider');
  if (llmProv) {
    llmProv.onchange = () => {
      const custom = $('s-llm-custom-url').checked;
      $('s-llm-base').value = presetLlmBase(llmProv.value);
      $('wrap-llm-base').classList.toggle('hidden', !custom);
    };
  }
  const llmCustom = $('s-llm-custom-url');
  if (llmCustom) llmCustom.onchange = () => $('wrap-llm-base').classList.toggle('hidden', !llmCustom.checked);

  const ttsProv = $('s-tts-provider');
  if (ttsProv) {
    ttsProv.onchange = () => {
      const isOpenai = ttsProv.value === 'openai';
      $('wrap-tts-custom').classList.toggle('hidden', !isOpenai);
      $('wrap-tts-base').classList.toggle('hidden', !(isOpenai && $('s-tts-custom-url').checked));
    };
  }
  const ttsCustom = $('s-tts-custom-url');
  if (ttsCustom) {
    ttsCustom.onchange = () => {
      const show = $('s-tts-provider').value === 'openai' && ttsCustom.checked;
      $('wrap-tts-base').classList.toggle('hidden', !show);
    };
  }

  const sttProv = $('s-stt-provider');
  if (sttProv) {
    sttProv.onchange = () => {
      const isOpenai = sttProv.value === 'openai';
      $('wrap-stt-custom').classList.toggle('hidden', !isOpenai);
      $('wrap-stt-base').classList.toggle('hidden', !(isOpenai && $('s-stt-custom-url').checked));
    };
  }
  const sttCustom = $('s-stt-custom-url');
  if (sttCustom) sttCustom.onchange = () => $('wrap-stt-base').classList.toggle('hidden', !(sttProv.value === 'openai' && sttCustom.checked));

  const embedCustom = $('s-embed-custom-url');
  if (embedCustom) embedCustom.onchange = () => $('wrap-embed-base').classList.toggle('hidden', !embedCustom.checked);

  const rate = $('s-tts-rate');
  if (rate) rate.addEventListener('input', () => { $('s-tts-rate-val').textContent = Number(rate.value).toFixed(1) + '×'; });

  // 主题自定义颜色：改一下就预览（保存才生效）
  if ($('t-primary')) $('t-primary').addEventListener('input', () => applyAppearance(Object.assign({}, getSettings().appearance, { accent: 'custom', custom: { primary: $('t-primary').value, secondary: $('t-secondary').value } })));
  if ($('t-secondary')) $('t-secondary').addEventListener('input', () => applyAppearance(Object.assign({}, getSettings().appearance, { accent: 'custom', custom: { primary: $('t-primary').value, secondary: $('t-secondary').value } })));

  renderThemePresets();
}

/** 进入设置页 / 相关分类时回填所有表单 */
export function fillAllSettings() {
  fillLlm();
  fillTts();
  fillStt();
  fillEmbedding();
  fillPerform();
  if ($('t-primary')) $('t-primary').value = (getSettings().theme && getSettings().theme.primary) || '#c87898';
  if ($('t-secondary')) $('t-secondary').value = (getSettings().theme && getSettings().theme.secondary) || '#a99ac7';
  renderThemePresets();
}

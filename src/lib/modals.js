// ============================================================
// 设置类弹窗控制器：对话/TTS/STT 设置、外观调色、屏幕视觉、设置菜单
// ============================================================
import { getSettings, saveSettings, hasApiKey } from './settings.js';
import { state, presetLlmBase, presetEmbeddingBase, presetEmbeddingModel } from './state.js';
import { $, toast } from './dom.js';
import { escapeHtml } from './markdown.js';
import { t } from './i18n.js';

// ---------------- API Key 字段（只写） ----------------
//
// 渲染层拿不到明文密钥，所以输入框平时是空的；已配置时填一个掩码。
// 语义（三种状态都要让用户能表达清楚）：
//   · 掩码原样不动  → 不改动已有密钥
//   · 填新字符串    → 覆盖
//   · 把输入框清空  → 删除密钥（否则用户没有任何办法撤销一个配错的 Key）
const KEY_MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';

function setKeyField(id, group) {
  const el = $(id);
  if (!el) return;
  const configured = hasApiKey(group);
  el.value = configured ? KEY_MASK : '';
  el.placeholder = configured ? t('llm.keyKeepHint') : 'sk-…';
}

/** 用户这次在输入框里真正输入的新密钥（什么都没输 / 只有掩码 → 空） */
function typedKey(id) {
  const el = $(id);
  const v = el ? el.value.trim() : '';
  return (!v || v === KEY_MASK) ? '' : v;
}

/** 送进设置的 apiKey 值：'' = 保持不变，SECRET_CLEAR = 清除，其它 = 新密钥 */
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

// ---------------- 对话设置 ----------------
export function openLlmModal() {
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
    apiKey: keyPatch('s-llm-key', 'llm'),
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
  setKeyField('s-tts-key', 'tts');
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
    apiKey: keyPatch('s-tts-key', 'tts'),
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
  setKeyField('s-stt-key', 'stt');
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
    apiKey: keyPatch('s-stt-key', 'stt'),
    model: $('s-stt-model').value.trim(),
  };
  saveSettings(next).then(() => {
    toast(t('stt.saved'));
    closeSubModal('modal-stt');
  });
}

// ---------------- 嵌入模型设置（长期记忆 / 知识库） ----------------
/**
 * 打开「记忆与知识库」设置。
 *
 * 这里的东西只影响**语义检索**：关掉之后记忆与知识库仍然可用，
 * 只是检索退化成关键词匹配（离线可用，语义弱一些）。
 */
export function openEmbeddingModal() {
  const s = getSettings();
  const e = s.embedding || {};
  const mem = s.memoryCfg || {};
  const know = s.knowledgeCfg || {};
  $('s-embed-enabled').checked = e.enabled !== false;
  $('s-embed-provider').value = e.provider || 'openai';
  const custom = !!e.customBaseUrl || e.provider === 'custom';
  $('s-embed-custom-url').checked = custom;
  $('wrap-embed-base').classList.toggle('hidden', !custom);
  $('s-embed-base').value = e.baseUrl || presetEmbeddingBase(e.provider || 'openai');
  setKeyField('s-embed-key', 'embedding');
  $('s-embed-model').value = e.model || presetEmbeddingModel(e.provider || 'openai');
  $('s-mem-perchar').value = mem.perCharacter === false ? 'no' : 'yes';
  $('s-mem-tokens').value = mem.maxContextTokens ?? 800;
  $('s-know-tokens').value = know.maxContextTokens ?? 1200;
  $('modal-embedding').classList.remove('hidden');
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
    baseUrl: custom ? $('s-embed-base').value.trim() : presetEmbeddingBase(provider),
    apiKey: keyPatch('s-embed-key', 'embedding'),
    model: $('s-embed-model').value.trim(),
    batchSize: (s.embedding && s.embedding.batchSize) || 16,
  };
  next.memoryCfg = {
    ...(s.memoryCfg || {}),
    perCharacter: $('s-mem-perchar').value === 'yes',
    maxContextTokens: parseInt($('s-mem-tokens').value, 10) || 0,
  };
  next.knowledgeCfg = {
    ...(s.knowledgeCfg || {}),
    maxContextTokens: parseInt($('s-know-tokens').value, 10) || 0,
  };
  saveSettings(next).then(() => {
    toast(t('embed.saved'));
    closeSubModal('modal-embedding');
  });
}

/** 取当前表单里的 embedding 连接参数（「先测再存」用，不必先保存） */
function embeddingFormPayload() {
  return {
    baseUrl: $('s-embed-base').value.trim() || presetEmbeddingBase($('s-embed-provider').value),
    model: $('s-embed-model').value.trim(),
    // 只写语义：掩码不动=不传（由主进程用已保存的 Key）
    apiKey: typedKey('s-embed-key'),
  };
}

export async function fetchEmbeddingModels() {
  const btn = $('btn-embed-fetch');
  try {
    if (btn) btn.disabled = true;
    const res = await window.api.embeddingListModels(embeddingFormPayload());
    const list = (res && res.models) || [];
    const dl = $('dl-embed-models');
    if (dl) {
      dl.innerHTML = '';
      for (const id of list.slice(0, 200)) {
        const opt = document.createElement('option');
        opt.value = id;
        dl.appendChild(opt);
      }
    }
    const suggested = (res && res.suggested) || [];
    if (!list.length) {
      toast(t('embed.noModels'), true);
    } else if (suggested.length && !$('s-embed-model').value.trim()) {
      // 有像嵌入模型的就先填上，省得用户自己挑
      $('s-embed-model').value = suggested[0];
      toast(t('embed.fetched', { n: list.length }));
    } else {
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
/** 聊天区右上角的状态点：有没有配 API Key 一眼可见 */
export function refreshChatStatus() {
  const dot = $('chat-status');
  if (!dot) return;
  const s = getSettings();
  const ok = hasApiKey('llm');
  dot.classList.toggle('off', !ok);
  dot.title = ok ? t('chat.statusReady') : t('chat.statusNoKey');
}

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
  const b = s.behavior || {};
  sub('menu-sub-perform', t('perform.' + (b.narration || 'natural')) + ' · ' + t('perform.' + (b.pacing || 'natural')));
  const emb = s.embedding || {};
  sub('menu-sub-embedding', emb.enabled === false ? t('embed.off') : (emb.model || t('embed.builtin')));
  refreshChatStatus();
}

/** 供其他模块写入菜单副标题（如无边框展台开关状态） */
export function setMenuSub(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

// ---------------- 表演（括号动作 / 回复节奏） ----------------
export function openPerformModal() {
  const b = getSettings().behavior || {};
  $('p-narration').value = b.narration || 'natural';
  $('p-pacing').value = b.pacing || 'natural';
  $('modal-perform').classList.remove('hidden');
}

export function savePerformModal() {
  const next = { ...getSettings() };
  next.behavior = {
    ...(next.behavior || {}),
    narration: $('p-narration').value,
    pacing: $('p-pacing').value,
  };
  saveSettings(next).then(() => {
    toast(t('perform.saved'));
    closeSubModal('modal-perform');
  });
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
  if (!baseUrl) { toast(t('llm.needBaseUrl'), true); return; }
  try {
    // 请求在主进程发（带上刚输入的密钥，或已保存的那把）
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
    return;
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
  const theme = getSettings().theme || {};
  if ($('t-primary')) $('t-primary').value = theme.primary || '#ff7eb3';
  if ($('t-secondary')) $('t-secondary').value = theme.secondary || '#38b0de';
  markActivePreset();
}

export function openThemeModal() {
  // 同样别用 t 做局部变量名（遮蔽 i18n 的 t）
  const theme = getSettings().theme || {};
  themeSnapshot = { primary: theme.primary || '#ff7eb3', secondary: theme.secondary || '#38b0de' };
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

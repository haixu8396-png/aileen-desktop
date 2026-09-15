// ============================================================
// Elysia — 渲染进程入口
// 职责: 角色卡管理 / LLM 流式对话 / Live2D 舞台 / TTS / STT
// ============================================================
import { loadOml2d } from 'oh-my-live2d';
import { getSettings, loadSettings, saveSettings, deepMerge } from './lib/settings.js';
import { streamChat } from './lib/llm.js';
import { TTS } from './lib/tts.js';
import { STT } from './lib/stt.js';
import { emptyCard, buildSystemPrompt, cardFileName } from './lib/characters.js';
import { renderMarkdown, escapeHtml } from './lib/markdown.js';

const $ = (id) => document.getElementById(id);

// 错误收集（供自检诊断使用）
window.__ELYSIA_ERRORS = [];
window.addEventListener('error', (e) => window.__ELYSIA_ERRORS.push(String(e.message || e)));
window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  window.__ELYSIA_ERRORS.push('rejection: ' + String((r && r.message) || r));
});

// ---------------- LLM 供应商预设 ----------------
const LLM_PROVIDERS = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  moonshot: { label: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  siliconflow: { label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  zhipu: { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  qwen: { label: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  xiaomi: { label: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', model: 'MiMo-V2.5' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat' },
  ollama: { label: 'Ollama 本地', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
  custom: { label: '自定义', baseUrl: '', model: '' },
};

// ---------------- 全局状态 ----------------
let appInfo = null;
let settings = null;
let models = [];          // [{name, file, url}]
let characters = [];      // [{file, data}]
let current = null;       // {file, data}
let messages = [];        // [{role, content}]
let oml2d = null;
let busy = false;
let abortCtrl = null;
let lastAssistantText = '';
let editorCard = null;
let editorFile = null;

const tts = new TTS();
const stt = new STT();

// ---------------- 工具 ----------------
function toast(text, isError) {
  const el = $('toast');
  el.textContent = text;
  el.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast hidden'; }, isError ? 5000 : 2600);
}

function scrollBottom() {
  const box = $('messages');
  if (getSettings().behavior.autoScroll) {
    box.scrollTop = box.scrollHeight;
  }
  const sb = $('btn-scroll-down');
  if (sb) {
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    sb.classList.toggle('hidden', nearBottom);
  }
}

function avatarUrl(rel) {
  if (!rel) return '';
  if (/^(https?:|data:)/.test(rel)) return rel;
  return appInfo.modelBaseUrl + '/' + rel.replace(/^\/+/, '');
}

// ---------------- 启动 ----------------
async function boot() {
  appInfo = await window.api.appInfo();
  settings = await loadSettings();
  applyTheme(settings.theme);
  models = await window.api.listModels();
  characters = await window.api.listCharacters();
  await new Promise((resolve) => {
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(resolve);
    else resolve();
  });

  populateModelSelect();
  populateStageModelSelect();
  renderCharList();
  try {
    initLive2D();
  } catch (err) {
    console.error('[live2d] init failed:', err);
    $('stage-container').innerHTML = '<div class="stage-placeholder">Live2D 初始化失败：' + escapeHtml(String(err && err.message || err)) + '</div>';
  }
  renderEmptyState();

  const lastFile = localStorage.getItem('elysia.currentChar');
  const first = characters.find((c) => c.file === lastFile) || characters[0] || null;
  if (first) selectCharacter(first.file, { greet: true });

  bindEvents();
  $('input').focus();
}

// ---------------- 角色列表 ----------------
function renderCharList() {
  const box = $('char-list');
  box.innerHTML = '';
  if (!characters.length) {
    box.innerHTML = '<div class="char-item" style="color:var(--muted)">暂无角色卡，点击「新建角色」开始吧～</div>';
    return;
  }
  for (const c of characters) {
    const item = document.createElement('div');
    item.className = 'char-item' + (current && current.file === c.file ? ' active' : '');
    item.dataset.file = c.file;
    const img = document.createElement('img');
    img.src = avatarUrl(c.data.avatar) || 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="16" fill="#2c3040"/><text x="40" y="50" font-size="30" text-anchor="middle" fill="#9aa0b4" font-family="sans-serif">' + escapeHtml((c.data.name || '?').slice(0, 1)) + '</text></svg>');
    img.onerror = () => { img.src = ''; };
    const meta = document.createElement('div');
    meta.style.cssText = 'min-width:0';
    const nm = document.createElement('div');
    nm.className = 'ci-name';
    nm.textContent = c.data.name || c.file;
    const ds = document.createElement('div');
    ds.className = 'ci-desc';
    ds.textContent = c.data.description || '';
    meta.appendChild(nm); meta.appendChild(ds);
    const more = document.createElement('button');
    more.className = 'ci-more';
    more.textContent = '⋯';
    more.title = '角色卡菜单';
    more.onclick = (e) => { e.stopPropagation(); openCharMenuAt(c.file, e.clientX, e.clientY); };
    item.appendChild(img); item.appendChild(meta); item.appendChild(more);
    item.onclick = () => selectCharacter(c.file, { greet: true });
    item.oncontextmenu = (e) => { e.preventDefault(); openCharMenuAt(c.file, e.clientX, e.clientY); };
    box.appendChild(item);
  }
}

// ---------------- 角色卡菜单 ----------------
let currentMenuFile = null;

function openCharMenuAt(file, x, y) {
  currentMenuFile = file;
  const menu = $('char-menu');
  menu.classList.remove('hidden');
  menu.style.left = '0px';
  menu.style.top = '0px';
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}

function closeCharMenu() {
  $('char-menu').classList.add('hidden');
  currentMenuFile = null;
}

function findChar(file) {
  return characters.find((c) => c.file === file);
}

async function duplicateCard(file) {
  const c = findChar(file);
  if (!c) return;
  const copy = JSON.parse(JSON.stringify(c.data));
  copy.name = (copy.name || '角色') + ' 副本';
  copy.createdAt = Date.now();
  copy.updatedAt = Date.now();
  const res = await window.api.writeCharacter(cardFileName(copy), copy, 'create');
  if (res) {
    await refreshCharacters(res.file);
    toast('已复制为「' + copy.name + '」');
  }
}

async function deleteCard(file) {
  const c = findChar(file);
  if (!c) return;
  if (!confirm('确定删除角色「' + (c.data.name || file) + '」吗？')) return;
  await window.api.deleteCharacter(file);
  if (current && current.file === file) {
    current = null;
    messages = [];
    try { await window.api.clearChat(file); localStorage.removeItem(chatKey(file)); } catch { /* ignore */ }
  }
  await refreshCharacters();
  toast('角色已删除');
}

// ---------------- 快捷更换模型 / 语音 ----------------
let quickFile = null;

function populateQuickSelects() {
  const qm = $('q-model');
  qm.innerHTML = '<option value="">（不绑定）</option>' +
    models.map((m) => '<option value="' + escapeHtml(m.file) + '">' + escapeHtml(m.name) + '</option>').join('');
  const qv = $('q-voice');
  qv.innerHTML = '<option value="">（默认语音）</option>';
  let voices = [];
  try { voices = window.speechSynthesis.getVoices(); } catch { /* ignore */ }
  qv.innerHTML += voices.map((v) => '<option value="' + escapeHtml(v.name) + '">' + escapeHtml(v.name + ' · ' + v.lang) + '</option>').join('');
}

function openQuickModal(file) {
  const c = findChar(file);
  if (!c) return;
  quickFile = file;
  populateQuickSelects();
  $('q-model').value = c.data.model || '';
  $('q-voice').value = c.data.voice || '';
  $('quick-title').textContent = '更换模型 / 语音 · ' + (c.data.name || file);
  $('modal-quick').classList.remove('hidden');
}

async function saveQuickModal() {
  if (!quickFile) return;
  const c = findChar(quickFile);
  if (!c) return;
  const data = { ...c.data, model: $('q-model').value, voice: $('q-voice').value, updatedAt: Date.now() };
  await window.api.writeCharacter(quickFile.replace(/\.json$/, ''), data, 'update');
  characters = await window.api.listCharacters();
  renderCharList();
  $('modal-quick').classList.add('hidden');
  if (current && current.file === quickFile) selectCharacter(quickFile, { greet: false });
  toast('已更新');
}

// ---------------- 聊天记录（按角色持久化到文件，避免 localStorage 容量截断/清缓存丢失） ----------------
function chatKey(file) {
  return 'elysia.chat.' + file;
}

async function saveChatFor(file) {
  if (!file) return;
  try { await window.api.saveChat(file, messages); } catch { /* ignore */ }
}

async function loadChatFor(file) {
  try {
    const arr = await window.api.readChat(file);
    if (Array.isArray(arr) && arr.length) return arr;
  } catch { /* ignore */ }
  // 兼容旧版本：localStorage 里的历史记录迁移一次到文件
  try {
    const legacy = localStorage.getItem(chatKey(file));
    if (legacy) {
      const arr = JSON.parse(legacy);
      if (Array.isArray(arr) && arr.length) {
        await window.api.saveChat(file, arr);
        localStorage.removeItem(chatKey(file));
        return arr;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function updateChatHeader() {
  if (!current) { renderEmptyState(); return; }
  $('chat-avatar').src = avatarUrl(current.data.avatar);
  $('chat-name').textContent = current.data.name || current.file;
  $('chat-desc').textContent = current.data.description || '';
}

function renderEmptyState() {
  if (characters.length > 0) return;
  $('chat-avatar').src = '';
  $('chat-name').textContent = 'Elysia';
  $('chat-desc').textContent = '从零开始，搭建你的专属 AI 伴侣';
  const box = $('messages');
  box.innerHTML = '<div class="msg assistant">欢迎使用 Elysia ✨<br><br>点击左侧「＋ 新建角色」创建你的第一位角色卡，<br>然后在 ⚙ 设置 中填入 DeepSeek API Key，就可以开始对话啦～</div>';
  scrollBottom();
}

async function selectCharacter(file, opts = {}) {
  const found = characters.find((c) => c.file === file);
  if (!found) return;
  if (current && current.file !== file) {
    await saveChatFor(current.file);
    tts.cancel();
    if (abortCtrl) abortCtrl.abort();
    if (busy) setBusy(false);
  }
  current = found;
  localStorage.setItem('elysia.currentChar', file);
  renderCharList();
  updateChatHeader();

  // 绑定 Live2D 模型
  if (found.data.model) {
    const idx = models.findIndex((m) => m.file === found.data.model);
    if (idx >= 0) {
      setStageModelIndex(idx);
      if (oml2d && oml2d.modelIndex !== idx) oml2d.loadModelByIndex(idx);
    }
    updateStageModelName();
  }

  const saved = await loadChatFor(file);
  if (saved && saved.length) {
    messages = saved;
    lastAssistantText = (saved.slice().reverse().find((m) => m.role === 'assistant') || {}).content || '';
    renderMessages();
  } else if (opts.greet && found.data.first_mes && getSettings().behavior.greetingOnLoad) {
    messages = [];
    messages.push({ role: 'assistant', content: found.data.first_mes });
    renderMessages();
    lastAssistantText = found.data.first_mes;
    saveChatFor(file);
    if (getSettings().tts.autoPlay) tts.enqueue(found.data.first_mes, ttsSettingsForCharacter());
  } else {
    messages = [];
    renderMessages();
  }
}

// ---------------- 消息渲染 ----------------
function renderMessages() {
  const box = $('messages');
  box.innerHTML = '';
  for (const m of messages) {
    box.appendChild(makeMsgEl(m.role, m.content));
  }
  scrollBottom();
}

function copyText(text) {
  navigator.clipboard.writeText(String(text || ''))
    .then(() => toast('已复制'))
    .catch(() => toast('复制失败', true));
}

function speakText(text) {
  if (text) tts.enqueue(String(text), ttsSettingsForCharacter());
}

function makeMsgEl(role, content) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  if (role === 'assistant') div.innerHTML = renderMarkdown(content);
  else div.textContent = content;
  const acts = document.createElement('div');
  acts.className = 'msg-actions';
  if (role === 'assistant') {
    const sp = document.createElement('button');
    sp.textContent = '🔊';
    sp.title = '朗读';
    sp.onclick = () => speakText(content);
    acts.appendChild(sp);
  }
  const cp = document.createElement('button');
  cp.textContent = '⧉';
  cp.title = '复制';
  cp.onclick = () => copyText(content);
  acts.appendChild(cp);
  div.appendChild(acts);
  return div;
}

function pushMsg(role, content) {
  messages.push({ role, content });
  const box = $('messages');
  const el = makeMsgEl(role, content);
  box.appendChild(el);
  scrollBottom();
  return el;
}

// 角色卡绑定的语音优先于全局设置
function ttsSettingsForCharacter() {
  const s = getSettings();
  const voice = (current && current.data && current.data.voice) || s.tts.voice;
  if (voice === s.tts.voice) return s;
  return deepMerge(s, { tts: { voice } });
}

function setBusy(b) {
  busy = b;
  $('btn-send').disabled = b;
  $('btn-stop').disabled = !b;
  $('typing').className = 'typing' + (b ? '' : ' hidden');
}

// ---------------- 聊天 ----------------
async function runAssistantReply(userContent, forceSpeak, image) {
  if (!current) throw new Error('请先创建并选择一个角色卡');
  if (!settings.llm.apiKey) throw new Error('未配置 LLM API Key');
  pushMsg('user', userContent);
  const history = messages.slice(-12).map((m) => ({ role: m.role, content: m.content }));
  const msgs = [{ role: 'system', content: buildSystemPrompt(current.data) }, ...history];
  // 带图时，把最后一条用户消息替换为「文本 + 图片」的多模态格式
  if (image) {
    msgs[msgs.length - 1] = {
      role: 'user',
      content: [
        { type: 'text', text: userContent },
        { type: 'image_url', image_url: { url: image.dataURL } },
      ],
    };
  }

  setBusy(true);
  const el = pushMsg('assistant', '');
  let acc = '';
  abortCtrl = new AbortController();

  try {
    await streamChat({
      messages: msgs,
      settings,
      signal: abortCtrl.signal,
      onDelta: (d) => {
        acc += d;
        el.innerHTML = renderMarkdown(acc) + '<span class="caret"></span>';
        scrollBottom();
      },
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      if (acc) el.innerHTML = renderMarkdown(acc) + ' <span class="caret"></span>';
    } else {
      el.innerHTML = '<span style="color:#ff9aa8">⚠ ' + escapeHtml(String(err && err.message ? err.message : err)) + '</span>';
    }
  }
  el.innerHTML = renderMarkdown(acc);
  messages[messages.length - 1] = { role: 'assistant', content: acc };
  setBusy(false);
  scrollBottom();

  lastAssistantText = acc;
  if (current) saveChatFor(current.file);
  const shouldSpeak = acc.length > 0 && (forceSpeak || getSettings().tts.autoPlay);
  if (shouldSpeak) tts.enqueue(acc, ttsSettingsForCharacter());
  return acc;
}

async function send(text) {
  const content = String(text || '').trim();
  const image = pendingImage;
  if ((!content && !image) || busy) return;
  if (!settings.llm.apiKey) {
    toast('请先在 💬 对话设置 中填写 API Key');
    openLlmModal();
    return;
  }
  $('input').value = '';
  autoGrowInput();
  pendingImage = null;
  setAttachUI();
  try {
    await runAssistantReply(content || '请看看这张截图，告诉我你看到了什么。', false, image);
  } catch (err) {
    toast(String(err && err.message ? err.message : err), true);
  }
}

// ---------------- 屏幕视觉（截图发给角色） ----------------
let pendingImage = null;

function setAttachUI() {
  const bar = $('attach-bar');
  if (pendingImage) {
    $('attach-preview').src = pendingImage.dataURL;
    $('attach-name').textContent = pendingImage.name;
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
  }
}

async function openScreenPicker() {
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
      pendingImage = { dataURL: src.thumbnail, name: src.name };
      setAttachUI();
      $('modal-screen').classList.add('hidden');
      toast('已附加截图，输入问题后发送（需多模态模型）');
    };
    grid.appendChild(item);
  }
  $('modal-screen').classList.remove('hidden');
}

// ---------------- 添加 Live2D 模型（设置 → 模型设置） ----------------
function openModelModal() {
  populateStageModelSelect();
  renderUrlList();
  $('modal-model').classList.remove('hidden');
}

async function addModelFromFolder() {
  const list = await window.api.addModelFolder();
  if (list) {
    await refreshModelsAfterAdd();
    toast('模型已导入到 models/ 目录');
  }
}

function showUrlForm() {
  $('m-url-form').classList.remove('hidden');
  $('m-url-input').focus();
}

async function submitUrlForm() {
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

function renderUrlList() {
  const box = $('m-url-list');
  if (!box) return;
  const urls = models.filter((m) => m.source === 'url');
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
      models = await window.api.removeModelUrl(m.url);
      populateModelSelect();
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

async function refreshModelsAfterAdd() {
  models = await window.api.listModels();
  populateModelSelect();
  populateStageModelSelect();
  rebuildLive2D();
  if (current && current.data.model) {
    const idx = models.findIndex((m) => m.file === current.data.model);
    if (idx >= 0) setStageModelIndex(idx);
  }
}

function setStageModelIndex(idx) {
  const sel = $('m-model');
  if (sel && !isNaN(idx) && idx >= 0) sel.value = String(idx);
}

// ---------------- 外观调色 ----------------
const THEME_PRESETS = [
  { name: 'Elysia 粉', primary: '#ff7eb3', secondary: '#38b0de' },
  { name: '晴空蓝', primary: '#38b0de', secondary: '#7c9bff' },
  { name: '薄荷绿', primary: '#4ecdc4', secondary: '#a8e6a3' },
  { name: '星夜紫', primary: '#a78bfa', secondary: '#f472b6' },
  { name: '熔岩橙', primary: '#ff8c5a', secondary: '#ffd166' },
  { name: '蜜桃甜', primary: '#ff6f91', secondary: '#ffc75f' },
];

function applyTheme(t) {
  const theme = t || {};
  const p = theme.primary || '#ff7eb3';
  const s = theme.secondary || '#38b0de';
  const root = document.documentElement;
  root.style.setProperty('--accent', p);
  root.style.setProperty('--accent2', s);
}

function renderThemePresets() {
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

function openThemeModal() {
  const t = settings.theme || {};
  $('t-primary').value = t.primary || '#ff7eb3';
  $('t-secondary').value = t.secondary || '#38b0de';
  renderThemePresets();
  $('modal-theme').classList.remove('hidden');
}

function saveThemeModal() {
  const next = { ...settings };
  next.theme = {
    primary: $('t-primary').value,
    secondary: $('t-secondary').value,
  };
  saveSettings(next).then(() => {
    settings = getSettings();
    applyTheme(settings.theme);
    toast('外观已保存');
    $('modal-theme').classList.add('hidden');
  });
}

function rebuildLive2D() {
  const container = $('stage-container');
  if (oml2d) {
    try { if (oml2d.pixiApp) oml2d.pixiApp.destroy(true); } catch { /* ignore */ }
    oml2d = null;
  }
  if (container) container.innerHTML = '';
  initLive2D();
}

// ---------------- 实时语音对话（说话 → 回复 → 继续听） ----------------
let voiceLoop = false;

function setVoiceLoopUI() {
  const btn = $('btn-realtime');
  if (btn) btn.classList.toggle('active', voiceLoop);
  const typing = $('typing');
  if (voiceLoop) {
    typing.className = 'typing';
    typing.textContent = '实时对话中：请说话…（再次点击按钮停止）';
  }
}

function startVoiceLoop() {
  if (!current) {
    toast('请先创建并选择一个角色卡', true);
    openCharModal(null, null);
    return;
  }
  voiceLoop = true;
  setVoiceLoopUI();
  voiceListen();
}

function stopVoiceLoop() {
  voiceLoop = false;
  stt.stop();
  setVoiceLoopUI();
  $('typing').className = 'typing hidden';
}

async function voiceListen() {
  if (!voiceLoop) return;
  stt.onResult = (text) => {
    if (!voiceLoop) return;
    const t = String(text || '').trim();
    if (!t) { setTimeout(voiceListen, 300); return; }
    $('typing').textContent = '实时对话中：思考中…';
    runAssistantReply(t, true)
      .catch((err) => toast(String(err && err.message ? err.message : err), true))
      .then(() => {
        if (!voiceLoop) return;
        $('typing').textContent = '实时对话中：回复中…';
        waitTtsIdle().then(() => {
          if (!voiceLoop) return;
          $('typing').textContent = '实时对话中：请说话…';
          setTimeout(voiceListen, 250);
        });
      });
  };
  stt.onError = (err) => {
    toast('语音识别: ' + (err && err.message ? err.message : err), true);
    if (voiceLoop) setTimeout(voiceListen, 900);
  };
  stt.start(settings);
}

function waitTtsIdle() {
  return new Promise((resolve) => {
    if (tts.idle) return resolve();
    const iv = setInterval(() => { if (tts.idle) { clearInterval(iv); resolve(); } }, 150);
    setTimeout(() => { clearInterval(iv); resolve(); }, 180000);
  });
}

// ---------------- Live2D ----------------
function initLive2D() {
  const container = $('stage-container');
  if (!models.length) {
    container.innerHTML = '<div class="stage-placeholder">还没有 Live2D 模型～<br>可以在「⚙ 设置 → 🎀 Live2D 模型设置」里<br>从文件夹导入或从网址加载。<br><button id="btn-goto-models" class="ghost">去添加模型</button></div>';
    const go = container.querySelector('#btn-goto-models');
    if (go) go.onclick = () => openModelModal();
    return;
  }
  const W = container.clientWidth || 400;
  const H = container.clientHeight || 600;
  // 关键：默认舞台是 position:fixed 且铺满视口，会盖住整个界面导致所有按钮无法点击。
  // 这里在模型级 stageStyle 强制 position:absolute，把舞台约束在右侧面板容器内。
  oml2d = loadOml2d({
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
    models: models.map((m) => ({
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
  oml2d.onLoad((status) => {
    if (status === 'success') refreshStageControls();
  });
  if (oml2d && typeof oml2d.then === 'function') {
    oml2d.catch((err) => {
      console.error('[live2d] load failed:', err);
      const box = $('stage-container');
      if (box && !box.querySelector('canvas')) {
        box.innerHTML = '<div class="stage-placeholder">Live2D 加载失败：' + escapeHtml(String(err && err.message || err)) + '</div>';
      }
    });
  }
}

function getLive2dModel() {
  try {
    return (oml2d && oml2d.models && oml2d.models.model) || null;
  } catch { return null; }
}
window.__ELYSIA_MODEL_READY = () => !!getLive2dModel();
window.__ELYSIA_REFRESH = async () => { await refreshCharacters(); };

function refreshStageControls() {
  const model = getLive2dModel();
  const mc = $('motion-chips');
  const ec = $('expr-chips');
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

function talkMotionName() {
  const model = getLive2dModel();
  if (!model) return null;
  try {
    const groups = Object.keys(model.internalModel.motionManager.motionGroups || {});
    if (!groups.length) return null;
    const prefer = groups.find((g) => /tap|talk|speak|wave|greet/i.test(g));
    return prefer || groups.find((g) => !/idle/i.test(g)) || groups[0];
  } catch { return null; }
}

function idleMotionName() {
  const model = getLive2dModel();
  if (!model) return null;
  try {
    const groups = Object.keys(model.internalModel.motionManager.motionGroups || {});
    return groups.find((g) => /idle/i.test(g)) || groups[0] || null;
  } catch { return null; }
}

// TTS 期间驱动模型动作
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

// ---------------- 角色编辑弹窗 ----------------
function populateModelSelect(select) {
  const el = select || $('f-model');
  el.innerHTML = '<option value="">（不绑定）</option>' +
    models.map((m, i) => '<option value="' + escapeHtml(m.file) + '">' + escapeHtml(m.name) + '</option>').join('');
}

function updateStageModelName() {
  const sel = $('m-model');
  const hint = $('stage-model-name');
  if (!sel || !hint) return;
  const opt = sel.options[sel.selectedIndex];
  hint.textContent = opt && opt.value !== '-1' ? opt.textContent : '未加载模型';
}

function populateStageModelSelect() {
  const el = $('m-model');
  if (!el) return;
  el.innerHTML = models.length
    ? models.map((m, i) => '<option value="' + i + '">' + escapeHtml(m.name) + '</option>').join('')
    : '<option value="-1">（无模型）</option>';
  updateStageModelName();
}

function populateVoiceSelect() {
  const el = $('f-voice');
  el.innerHTML = '<option value="">（默认语音）</option>';
  let voices = [];
  try { voices = window.speechSynthesis.getVoices(); } catch { /* ignore */ }
  if (!voices.length) return;
  voices = voices.slice().sort((a, b) => (a.lang < b.lang ? -1 : 1));
  el.innerHTML += voices.map((v) => '<option value="' + escapeHtml(v.name) + '">' + escapeHtml(v.name + ' · ' + v.lang) + '</option>').join('');
}

function openCharModal(card, file) {
  editorCard = card ? deepMerge(emptyCard(), card) : emptyCard();
  editorFile = file || null;
  $('char-modal-title').textContent = editorFile ? '编辑角色：' + editorCard.name : '新建角色卡';
  $('f-name').value = editorCard.name || '';
  $('f-desc').value = editorCard.description || '';
  $('f-personality').value = editorCard.personality || '';
  $('f-scenario').value = editorCard.scenario || '';
  $('f-first').value = editorCard.first_mes || '';
  $('f-example').value = editorCard.mes_example || '';
  $('f-system').value = editorCard.system_prompt || '';
  populateModelSelect();
  populateVoiceSelect();
  $('f-model').value = editorCard.model || '';
  $('f-voice').value = editorCard.voice || '';
  $('f-avatar-preview').src = avatarUrl(editorCard.avatar);
  $('f-delete').classList.toggle('hidden', !editorFile);
  $('modal-char').classList.remove('hidden');
}

function closeCharModal() {
  $('modal-char').classList.add('hidden');
}

function saveCharModal() {
  const name = $('f-name').value.trim();
  if (!name) { toast('角色名不能为空', true); return; }
  editorCard.name = name;
  editorCard.description = $('f-desc').value.trim();
  editorCard.personality = $('f-personality').value.trim();
  editorCard.scenario = $('f-scenario').value.trim();
  editorCard.first_mes = $('f-first').value.trim();
  editorCard.mes_example = $('f-example').value.trim();
  editorCard.system_prompt = $('f-system').value.trim();
  editorCard.model = $('f-model').value;
  editorCard.voice = $('f-voice').value;
  editorCard.updatedAt = Date.now();
  if (!editorCard.createdAt) editorCard.createdAt = Date.now();

  const file = cardFileName(editorCard);
  window.api.writeCharacter(file, editorCard, editorFile ? 'update' : 'create').then((res) => {
    toast('角色卡已保存');
    closeCharModal();
    return refreshCharacters(res.file);
  });
}

async function refreshCharacters(preferFile) {
  characters = await window.api.listCharacters();
  renderCharList();
  if (preferFile) selectCharacter(preferFile, { greet: false });
  else if (!current && characters.length) selectCharacter(characters[0].file, { greet: true });
}

// ---------------- 设置弹窗 ----------------
// ---------------- 三个独立设置弹窗 ----------------
function presetLlmBase(provider) {
  const p = LLM_PROVIDERS[provider];
  return (p && p.baseUrl) || '';
}

function openLlmModal() {
  const s = settings;
  const prov = LLM_PROVIDERS[s.llm.provider] ? s.llm.provider : 'custom';
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

function saveLlmModal() {
  const next = { ...settings };
  const provider = $('s-llm-provider').value;
  const custom = $('s-llm-custom-url').checked;
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
    settings = getSettings();
    toast('对话设置已保存');
    $('modal-llm').classList.add('hidden');
  });
}

function openTtsModal() {
  const s = settings;
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

function saveTtsModal() {
  const next = { ...settings };
  const provider = $('s-tts-provider').value;
  const custom = provider === 'openai' && $('s-tts-custom-url').checked;
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
    settings = getSettings();
    toast('TTS 设置已保存');
    $('modal-tts').classList.add('hidden');
  });
}

function openSttModal() {
  const s = settings;
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

function saveSttModal() {
  const next = { ...settings };
  const provider = $('s-stt-provider').value;
  const custom = provider === 'openai' && $('s-stt-custom-url').checked;
  next.stt = {
    provider,
    language: $('s-stt-language').value,
    customBaseUrl: custom,
    baseUrl: custom ? $('s-stt-base').value.trim() : 'https://api.openai.com/v1',
    apiKey: $('s-stt-key').value.trim(),
    model: $('s-stt-model').value.trim(),
  };
  saveSettings(next).then(() => {
    settings = getSettings();
    toast('STT 设置已保存');
    $('modal-stt').classList.add('hidden');
  });
}

// ---------------- 设置菜单副标题 ----------------
function refreshMenuSubtitles() {
  const llm = settings.llm;
  const prov = LLM_PROVIDERS[llm.provider] ? LLM_PROVIDERS[llm.provider].label : '自定义';
  $('menu-sub-llm').textContent = prov + ' · ' + (llm.model || '未设置模型');
  const ttsLabel = { web: '系统语音', openai: 'OpenAI 兼容', fish: 'Fish Audio', xiaomi: '小米 MiMo' }[settings.tts.provider] || '';
  $('menu-sub-tts').textContent = ttsLabel + ' · ' + String(settings.tts.language || 'zh').toUpperCase();
  const sttLabel = { openai: 'Whisper 兼容', xiaomi: '小米 ASR', web: '浏览器' }[settings.stt.provider] || '';
  $('menu-sub-stt').textContent = sttLabel + ' · ' + String(settings.stt.language || 'zh').toUpperCase();
  $('menu-sub-model').textContent = models.length ? models.length + ' 个模型' : '暂无模型';
  $('menu-sub-theme').textContent = '主色 ' + ((settings.theme && settings.theme.primary) || '#ff7eb3');
}

// ---------------- 获取模型 / 音色列表 ----------------
function fillDatalist(id, items) {
  const dl = $(id);
  if (dl) dl.innerHTML = items.map((x) => '<option value="' + escapeHtml(String(x)) + '"></option>').join('');
}

async function fetchLlmModels() {
  const provider = $('s-llm-provider').value;
  const custom = $('s-llm-custom-url').checked;
  const baseUrl = custom ? $('s-llm-base').value.trim() : presetLlmBase(provider);
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

async function testLlmConnection() {
  const provider = $('s-llm-provider').value;
  const custom = $('s-llm-custom-url').checked;
  const baseUrl = custom ? $('s-llm-base').value.trim() : presetLlmBase(provider);
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

async function fetchTtsVoices() {
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

async function fetchSttModels() {
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

// ---------------- 事件绑定 ----------------
function autoGrowInput() {
  const el = $('input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function bindEvents() {
  // 发送
  $('btn-send').onclick = () => send($('input').value);
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send($('input').value);
    }
  });
  $('input').addEventListener('input', autoGrowInput);

  // 停止 / 清空 / 朗读
  $('btn-stop').onclick = () => {
    if (abortCtrl) abortCtrl.abort();
    tts.cancel();
    setBusy(false);
  };
  $('btn-clear').onclick = () => {
    if (busy && abortCtrl) abortCtrl.abort();
    tts.cancel();
    messages = [];
    lastAssistantText = '';
    renderMessages();
    toast('对话已清空');
  };
  $('btn-speak').onclick = () => {
    if (lastAssistantText) tts.enqueue(lastAssistantText, ttsSettingsForCharacter());
    else toast('还没有可朗读的内容');
  };

  // 实时语音对话
  $('btn-realtime').onclick = () => {
    if (voiceLoop) stopVoiceLoop();
    else startVoiceLoop();
  };

  // LLM 供应商切换：自动填充地址与模型
  $('s-llm-provider').addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      $('s-llm-custom-url').checked = true;
      $('wrap-llm-base').classList.remove('hidden');
      return;
    }
    const p = LLM_PROVIDERS[e.target.value];
    if (p) {
      if (!$('s-llm-custom-url').checked) $('s-llm-base').value = p.baseUrl;
      $('s-llm-model').value = p.model;
    }
  });

  // 自定义接口地址开关
  $('s-llm-custom-url').addEventListener('change', (e) => {
    const on = e.target.checked;
    $('wrap-llm-base').classList.toggle('hidden', !on);
    if (on && !$('s-llm-base').value.trim()) {
      $('s-llm-base').value = presetLlmBase($('s-llm-provider').value);
    }
  });
  $('s-tts-provider').addEventListener('change', (e) => {
    const isOpenai = e.target.value === 'openai';
    $('wrap-tts-custom').classList.toggle('hidden', !isOpenai);
    $('wrap-tts-base').classList.toggle('hidden', !(isOpenai && $('s-tts-custom-url').checked));
  });
  $('s-tts-custom-url').addEventListener('change', (e) => {
    $('wrap-tts-base').classList.toggle('hidden', !e.target.checked);
  });
  $('s-stt-provider').addEventListener('change', (e) => {
    const isOpenai = e.target.value === 'openai';
    $('wrap-stt-custom').classList.toggle('hidden', !isOpenai);
    $('wrap-stt-base').classList.toggle('hidden', !(isOpenai && $('s-stt-custom-url').checked));
  });
  $('s-stt-custom-url').addEventListener('change', (e) => {
    $('wrap-stt-base').classList.toggle('hidden', !e.target.checked);
  });

  // 语音输入
  $('btn-mic').onclick = () => {
    const btn = $('btn-mic');
    if (stt.recognizing) {
      stt.stop();
      return;
    }
    stt.onResult = (text) => {
      const input = $('input');
      input.value = (input.value ? input.value + ' ' : '') + text;
      autoGrowInput();
      input.focus();
      toast('识别完成');
    };
    stt.onError = (err) => toast('语音识别: ' + (err && err.message ? err.message : err), true);
    stt.onState = (on) => btn.classList.toggle('recording', on);
    stt.start(settings);
  };

  // 侧栏
  $('btn-new-card').onclick = () => openCharModal(null, null);
  $('btn-import-card').onclick = async () => {
    const res = await window.api.importCharacter();
    if (res) {
      await refreshCharacters(res.file);
      toast('角色卡已导入');
    }
  };
  $('btn-settings-menu').onclick = () => { refreshMenuSubtitles(); $('modal-menu').classList.remove('hidden'); };
  $('btn-open-data').onclick = () => window.api.openPath(appInfo.userDataDir || appInfo.dataDir || appInfo.appRoot);
  document.querySelectorAll('#modal-menu .menu-list button').forEach((btn) => {
    btn.onclick = () => {
      $('modal-menu').classList.add('hidden');
      $(btn.dataset.target).classList.remove('hidden');
    };
  });
  $('menu-cancel').onclick = () => $('modal-menu').classList.add('hidden');

  // 屏幕截图
  $('btn-screenshot').onclick = openScreenPicker;
  $('attach-remove').onclick = () => { pendingImage = null; setAttachUI(); };
  $('screen-cancel').onclick = () => $('modal-screen').classList.add('hidden');

  // 模型设置弹窗
  $('btn-add-model').onclick = addModelFromFolder;
  $('btn-add-url-model').onclick = showUrlForm;
  $('btn-refresh-models').onclick = refreshModelsAfterAdd;
  $('m-url-ok').onclick = submitUrlForm;
  $('m-url-cancel').onclick = () => $('m-url-form').classList.add('hidden');
  $('m-url-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) submitUrlForm(); });
  $('m-cancel').onclick = () => $('modal-model').classList.add('hidden');

  // 外观调色
  $('t-save').onclick = saveThemeModal;
  $('t-cancel').onclick = () => $('modal-theme').classList.add('hidden');
  $('t-reset').onclick = () => {
    $('t-primary').value = '#ff7eb3';
    $('t-secondary').value = '#38b0de';
    applyTheme({ primary: '#ff7eb3', secondary: '#38b0de' });
  };
  $('s-tts-rate').addEventListener('input', (e) => {
    $('s-tts-rate-val').textContent = Number(e.target.value).toFixed(1) + '×';
  });
  $('t-primary').addEventListener('input', (e) => applyTheme({ primary: e.target.value, secondary: $('t-secondary').value }));
  $('t-secondary').addEventListener('input', (e) => applyTheme({ primary: $('t-primary').value, secondary: e.target.value }));

  // 角色卡菜单
  document.querySelectorAll('#char-menu button[data-act]').forEach((btn) => {
    btn.onclick = () => {
      const act = btn.dataset.act;
      const file = currentMenuFile;
      closeCharMenu();
      if (!file) return;
      const c = findChar(file);
      if (act === 'edit') { if (c) openCharModal(c.data, file); }
      else if (act === 'quick') openQuickModal(file);
      else if (act === 'duplicate') duplicateCard(file);
      else if (act === 'export') { if (c) window.api.exportCharacter(c.data).then((p) => p && toast('已导出到 ' + p)); }
      else if (act === 'delete') deleteCard(file);
    };
  });
  $('btn-char-actions').onclick = () => {
    if (!current) { toast('请先选择角色卡', true); return; }
    const rect = $('btn-char-actions').getBoundingClientRect();
    openCharMenuAt(current.file, rect.left, rect.bottom + 4);
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#char-menu') && !e.target.closest('.ci-more') && !e.target.closest('#btn-char-actions')) {
      closeCharMenu();
    }
  });

  // 快捷更换模型 / 语音
  $('q-cancel').onclick = () => $('modal-quick').classList.add('hidden');
  $('q-save').onclick = saveQuickModal;

  // 滚动到底
  $('btn-scroll-down').onclick = () => {
    const box = $('messages');
    box.scrollTop = box.scrollHeight;
    $('btn-scroll-down').classList.add('hidden');
  };
  $('messages').addEventListener('scroll', () => {
    const box = $('messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    $('btn-scroll-down').classList.toggle('hidden', nearBottom);
  });

  // Esc 关闭弹窗/菜单（保留正在编辑的角色卡弹窗，避免误关丢失内容）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeCharMenu();
      document.querySelectorAll('.modal').forEach((m) => {
        if (m.id !== 'modal-char') m.classList.add('hidden');
      });
    }
  });

  // 模型切换（模型设置弹窗）
  $('m-model').onchange = (e) => {
    const idx = parseInt(e.target.value, 10);
    if (!isNaN(idx) && oml2d) oml2d.loadModelByIndex(idx);
    updateStageModelName();
  };

  // 角色编辑弹窗
  $('f-cancel').onclick = closeCharModal;
  $('f-save').onclick = saveCharModal;
  $('f-delete').onclick = async () => {
    if (!editorFile) return;
    if (!confirm('确定删除角色「' + editorCard.name + '」吗？')) return;
    await window.api.deleteCharacter(editorFile);
    closeCharModal();
    if (current && current.file === editorFile) current = null;
    await refreshCharacters();
    toast('角色已删除');
  };
  $('f-export').onclick = async () => {
    const name = $('f-name').value.trim();
    const card = { ...editorCard, name: name || editorCard.name };
    const res = await window.api.exportCharacter(card);
    if (res) toast('已导出到 ' + res);
  };
  $('f-avatar-btn').onclick = async () => {
    const res = await window.api.chooseAvatar();
    if (res) {
      editorCard.avatar = res.rel;
      $('f-avatar-preview').src = res.url;
    }
  };

  // 三个独立设置弹窗
  $('s-llm-cancel').onclick = () => $('modal-llm').classList.add('hidden');
  $('s-llm-save').onclick = saveLlmModal;
  $('s-tts-cancel').onclick = () => $('modal-tts').classList.add('hidden');
  $('s-tts-save').onclick = saveTtsModal;
  $('s-stt-cancel').onclick = () => $('modal-stt').classList.add('hidden');
  $('s-stt-save').onclick = saveSttModal;
  $('btn-llm-fetch').onclick = fetchLlmModels;
  $('btn-llm-test').onclick = testLlmConnection;
  $('btn-tts-fetch').onclick = fetchTtsVoices;
  $('btn-stt-fetch').onclick = fetchSttModels;

  // 点击遮罩关闭
  $('modal-char').addEventListener('click', (e) => { if (e.target === $('modal-char')) closeCharModal(); });
  ['modal-llm', 'modal-tts', 'modal-stt', 'modal-screen', 'modal-menu', 'modal-model', 'modal-theme', 'modal-quick'].forEach((id) => {
    $(id).addEventListener('click', (e) => { if (e.target === $(id)) $(id).classList.add('hidden'); });
  });
}

// 系统语音列表可能异步加载
if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => { /* 下次打开编辑弹窗时刷新 */ };
}

boot();

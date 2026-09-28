// ============================================================
// 聊天控制器：消息渲染、流式回复、聊天记录持久化、朗读
// ============================================================
import { getSettings, deepMerge } from './settings.js';
import { streamChat } from './llm.js';
import { buildSystemPrompt } from './characters.js';
import { renderMarkdown, escapeHtml } from './markdown.js';
import { t } from './i18n.js';
import { createMarkerParser } from './marker-parser.js';
import { createReplyPacer } from './reply-pacer.js';
import { buildStyleInstruction } from './style.js';
import { splitForCompaction, buildContextMessages, buildSummaryRequest, summaryKey, summarizable, DEFAULT_KEEP_TURNS } from './history.js';
import { getLive2dModel } from './stage.js';
import { state, hooks, tts } from './state.js';
import { $, toast, scrollBottom, autoGrowInput } from './dom.js';

// ---------------- 聊天记录（按角色持久化到文件） ----------------
export function chatKey(file) {
  return 'aileen.chat.' + file;
}

/** 旧版本（Elysia 时期）的 localStorage 键，仅用于一次性迁移 */
function legacyChatKey(file) {
  return 'elysia.chat.' + file;
}

export async function saveChatFor(file) {
  if (!file) return;
  try { await window.api.saveChat(file, state.messages); } catch { /* ignore */ }
}

export async function loadChatFor(file) {
  try {
    const arr = await window.api.readChat(file);
    if (Array.isArray(arr) && arr.length) return arr;
  } catch { /* ignore */ }
  // 兼容旧版本：localStorage 里的历史记录迁移一次到文件
  try {
    const legacy = localStorage.getItem(legacyChatKey(file));
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

export async function clearChatFor(file) {
  if (!file) return;
  try {
    await window.api.clearChat(file);
    localStorage.removeItem(chatKey(file));
  } catch { /* ignore */ }
}

// ---------------- 消息渲染 ----------------
export function renderMessages() {
  const box = $('messages');
  if (!box) return;
  box.innerHTML = '';
  // 最后一条助手消息额外提供「重新生成」
  let lastAssistant = -1;
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    if (state.messages[i].role === 'assistant') { lastAssistant = i; break; }
  }
  state.messages.forEach((m, i) => {
    box.appendChild(makeMsgEl(m.role, m.content, i, i === lastAssistant));
  });
  scrollBottom();
}

export function copyText(text) {
  navigator.clipboard.writeText(String(text || ''))
    .then(() => toast(t('chat.copied')))
    .catch(() => toast(t('chat.copyFailed'), true));
}

export function speakText(text) {
  if (text) tts.enqueue(String(text), ttsSettingsForCharacter());
}

export function makeMsgEl(role, content, index, isLastAssistant) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  if (role === 'assistant') div.innerHTML = renderMarkdown(content);
  else div.textContent = content;
  const acts = document.createElement('div');
  acts.className = 'msg-actions';
  if (role === 'assistant') {
    const sp = document.createElement('button');
    sp.textContent = '🔊';
    sp.title = t('chat.readAloud');
    sp.onclick = () => speakText(content);
    acts.appendChild(sp);
  }
  const cp = document.createElement('button');
  cp.textContent = '⧉';
  cp.title = t('chat.copy');
  cp.onclick = () => copyText(content);
  acts.appendChild(cp);
  if (isLastAssistant) {
    const rg = document.createElement('button');
    rg.textContent = '↻';
    rg.title = t('chat.regenerate');
    rg.onclick = () => regenerateLast();
    acts.appendChild(rg);
  }
  if (typeof index === 'number') {
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = t('chat.deleteMsg');
    del.onclick = () => deleteMessage(index);
    acts.appendChild(del);
  }
  div.appendChild(acts);
  return div;
}

/** 删掉单条消息 */
export function deleteMessage(index) {
  if (index < 0 || index >= state.messages.length) return;
  state.messages.splice(index, 1);
  renderMessages();
  if (state.current) saveChatFor(state.current.file);
}

/** 重新生成：丢掉最后一条助手回复，用最后一条用户消息重跑一次 */
export async function regenerateLast() {
  if (state.busy) return;
  const msgs = state.messages;
  let idx = -1;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i].role === 'user') { idx = i; break; }
  }
  if (idx < 0) { toast(t('chat.nothingToRead')); return; }
  const content = msgs[idx].content;
  state.messages = msgs.slice(0, idx);
  renderMessages();
  try {
    await runAssistantReply(content, false, null);
  } catch (err) {
    toast(String((err && err.message) || err), true);
  }
}

export function pushMsg(role, content) {
  // 记时间戳：拼上下文时给用户消息加时间锚点（不给 assistant 加，否则模型会照着学）
  state.messages.push({ role, content, at: Date.now() });
  const box = $('messages');
  const el = makeMsgEl(role, content, state.messages.length - 1, false);
  box.appendChild(el);
  scrollBottom();
  return el;
}

/** 角色卡绑定的语音优先于全局设置 */
export function ttsSettingsForCharacter() {
  const s = getSettings();
  const cur = state.current;
  const voice = (cur && cur.data && cur.data.voice) || s.tts.voice;
  if (voice === s.tts.voice) return s;
  return deepMerge(s, { tts: { voice } });
}

export function setBusy(b) {
  state.busy = b;
  const send = $('btn-send');
  const stop = $('btn-stop');
  const typing = $('typing');
  if (send) send.disabled = b;
  if (stop) stop.disabled = !b;
  if (typing) typing.className = 'typing' + (b ? '' : ' hidden');
}

// ---------------- 上下文压缩 / 形象控制 ----------------

// 同一段旧消息只总结一次
const summaryCache = new Map();

async function ensureSummary(older, settings) {
  if (!summarizable(older)) return '';
  const key = summaryKey(older);
  if (summaryCache.has(key)) return summaryCache.get(key);
  const req = buildSummaryRequest(older, t('prompt.summarySystem'));
  let out = '';
  try {
    await streamChat({
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.body },
      ],
      settings,
      onDelta: (d) => { out += d; },
    });
  } catch (err) {
    return ''; // 总结失败就算了，宁可少点上下文，也不能把这次回复拖没
  }
  const text = String(out).replace(/\s+/g, ' ').trim();
  const full = text ? t('prompt.summaryLabel') + ' ' + text : '';
  if (full) summaryCache.set(key, full);
  return full;
}

/**
 * 写进系统提示词的两件事：
 *   1) 回复节奏（delay）—— 跟模型无关，永远都给
 *   2) 动作/表情标记 —— 需要真加载了模型才知道有哪些可用名
 */
function styleInstruction() {
  const parts = buildStyleInstruction(getSettings().behavior);
  const model = getLive2dModel();
  if (!model) return '\n\n' + parts.join('\n\n');
  let motions = [];
  let exprs = [];
  try {
    const mm = model.internalModel && model.internalModel.motionManager;
    motions = Object.keys((mm && mm.motionGroups) || {});
    const defs = (mm && mm.expressionManager && mm.expressionManager.definitions) || [];
    exprs = defs.map((d) => d.name).filter(Boolean);
  } catch (err) { /* 模型还没加载好就先不给指令 */ }
  if (motions.length || exprs.length) {
    parts.push(t('prompt.stage', {
      motions: motions.join(', ') || '-',
      exprs: exprs.join(', ') || '-',
    }));
  }
  return '\n\n' + parts.join('\n\n');
}

/** 模型写错标记不该打断说话，全部吞掉 */
function applyStageMarker(m) {
  if (!m || !m.value) return;
  const model = getLive2dModel();
  if (!model) return;
  try {
    if (m.kind === 'motion') model.motion(m.value);
    else if (m.kind === 'expr' || m.kind === 'expression' || m.kind === 'emote') model.expression(m.value);
  } catch (err) { /* ignore */ }
}

// ---------------- 对话 ----------------
export async function runAssistantReply(userContent, forceSpeak, image) {
  const cur = state.current;
  if (!cur) throw new Error(t('chat.needChar'));
  const s = getSettings();
  if (!s.llm.apiKey) throw new Error(t('chat.noApiKey'));
  pushMsg('user', userContent);

  // 最近若干轮原样带上，更早的压成一条摘要（以前是直接 slice(-12) 丢掉，角色会失忆）
  const { older, kept } = splitForCompaction(state.messages, DEFAULT_KEEP_TURNS);
  const summary = await ensureSummary(older, s);
  const history = buildContextMessages({ kept, summary });
  const msgs = [{ role: 'system', content: buildSystemPrompt(cur.data) + styleInstruction() }, ...history];

  // 带图时，把最后一条用户消息替换为「文本 + 图片」的多模态格式
  if (image) {
    const lastIdx = msgs.length - 1;
    const textOnly = String(msgs[lastIdx].content || '').replace(/^\[[^\]]+\]\s/, '');
    msgs[lastIdx] = {
      role: 'user',
      content: [
        { type: 'text', text: textOnly || userContent },
        { type: 'image_url', image_url: { url: image.dataURL } },
      ],
    };
  }

  setBusy(true);
  const shouldSpeak = forceSpeak || getSettings().tts.autoPlay;

  // 一条回复可能被模型用 delay 拆成好几条消息 —— 每段单独成气泡、单独落库、单独朗读。
  // 流式期间先挂「预览」元素，结束时用 renderMessages() 统一重画成正式消息
  //（那样才有正确的删除/重生成按钮）。
  const boxEl = $('messages');
  const segments = [];
  let preview = null;
  let curText = '';

  function setTyping(on) {
    const ty = $('typing');
    if (ty) ty.className = 'typing' + (on ? '' : ' hidden');
  }

  function startBubble() {
    curText = '';
    preview = document.createElement('div');
    preview.className = 'msg assistant';
    boxEl.appendChild(preview);
  }

  function seal(keepPreview) {
    const text = curText.trim();
    curText = '';
    if (!text) {
      if (!keepPreview && preview && preview.parentNode) preview.parentNode.removeChild(preview);
      preview = null;
      return;
    }
    segments.push(text);
    state.messages.push({ role: 'assistant', content: text, at: Date.now() });
    // 说到哪句就先读哪句，不等整段回复写完
    if (shouldSpeak) tts.enqueue(text, ttsSettingsForCharacter());
    preview = null;
  }

  startBubble();
  const pacer = createReplyPacer({
    onText: (chunk) => {
      if (!preview) startBubble();
      curText += chunk;
      setTyping(false);
      preview.innerHTML = renderMarkdown(curText) + '<span class="caret"></span>';
      scrollBottom();
    },
    onStage: (m) => applyStageMarker(m),
    onBreak: () => { seal(false); startBubble(); },
    onDelay: (sec) => { if (sec >= 1.2) setTyping(true); },
  });
  state.abortCtrl = new AbortController();

  let streamErr = null;
  try {
    await streamChat({
      messages: msgs,
      settings: s,
      signal: state.abortCtrl.signal,
      onDelta: (d) => pacer.push(d),
    });
  } catch (err) {
    streamErr = err;
  }
  await pacer.finish();
  setTyping(false);
  seal(true);

  if (streamErr && !(streamErr.name === 'AbortError') && preview) {
    preview.innerHTML = '<span style="color:#ff9aa8">⚠ ' + escapeHtml(String(streamErr.message || streamErr)) + '</span>';
  }
  setBusy(false);
  renderMessages();   // 统一重画：拿到正确的下标与各种消息操作
  scrollBottom();

  const acc = segments.join('\n\n');
  state.lastAssistantText = acc;
  if (state.current) saveChatFor(state.current.file);
  return acc;
}

export async function send(text) {
  const content = String(text || '').trim();
  const image = state.pendingImage;
  if ((!content && !image) || state.busy) return;
  const s = getSettings();
  if (!s.llm.apiKey) {
    toast(t('chat.needKeyHint'));
    hooks.openLlmModal();
    return;
  }
  const input = $('input');
  if (input) input.value = '';
  autoGrowInput();
  state.pendingImage = null;
  hooks.setAttachUI();
  try {
    await runAssistantReply(content || t('chat.visionPrompt'), false, image);
  } catch (err) {
    toast(String(err && err.message ? err.message : err), true);
  }
}

/** 清空当前对话 */
export function clearMessages() {
  if (state.busy && state.abortCtrl) state.abortCtrl.abort();
  tts.cancel();
  state.messages = [];
  state.lastAssistantText = '';
  renderMessages();
  if (state.current) clearChatFor(state.current.file);
}

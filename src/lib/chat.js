// ============================================================
// 聊天控制器：消息渲染、流式回复、聊天记录持久化、朗读
// ============================================================
import { getSettings, deepMerge } from './settings.js';
import { streamChat } from './llm.js';
import { buildSystemPrompt } from './characters.js';
import { renderMarkdown, escapeHtml } from './markdown.js';
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
  for (const m of state.messages) {
    box.appendChild(makeMsgEl(m.role, m.content));
  }
  scrollBottom();
}

export function copyText(text) {
  navigator.clipboard.writeText(String(text || ''))
    .then(() => toast('已复制'))
    .catch(() => toast('复制失败', true));
}

export function speakText(text) {
  if (text) tts.enqueue(String(text), ttsSettingsForCharacter());
}

export function makeMsgEl(role, content) {
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

export function pushMsg(role, content) {
  state.messages.push({ role, content });
  const box = $('messages');
  const el = makeMsgEl(role, content);
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

// ---------------- 对话 ----------------
export async function runAssistantReply(userContent, forceSpeak, image) {
  const cur = state.current;
  if (!cur) throw new Error('请先创建并选择一个角色卡');
  const s = getSettings();
  if (!s.llm.apiKey) throw new Error('未配置 LLM API Key');
  pushMsg('user', userContent);
  const history = state.messages.slice(-12).map((m) => ({ role: m.role, content: m.content }));
  const msgs = [{ role: 'system', content: buildSystemPrompt(cur.data) }, ...history];
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
  state.abortCtrl = new AbortController();

  try {
    await streamChat({
      messages: msgs,
      settings: s,
      signal: state.abortCtrl.signal,
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
  state.messages[state.messages.length - 1] = { role: 'assistant', content: acc };
  setBusy(false);
  scrollBottom();

  state.lastAssistantText = acc;
  if (state.current) saveChatFor(state.current.file);
  const shouldSpeak = acc.length > 0 && (forceSpeak || getSettings().tts.autoPlay);
  if (shouldSpeak) tts.enqueue(acc, ttsSettingsForCharacter());
  return acc;
}

export async function send(text) {
  const content = String(text || '').trim();
  const image = state.pendingImage;
  if ((!content && !image) || state.busy) return;
  const s = getSettings();
  if (!s.llm.apiKey) {
    toast('请先在 💬 对话设置 中填写 API Key');
    hooks.openLlmModal();
    return;
  }
  const input = $('input');
  if (input) input.value = '';
  autoGrowInput();
  state.pendingImage = null;
  hooks.setAttachUI();
  try {
    await runAssistantReply(content || '请看看这张截图，告诉我你看到了什么。', false, image);
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

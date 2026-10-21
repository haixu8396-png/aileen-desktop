// ============================================================
// 聊天控制器：消息渲染、流式回复、聊天记录持久化、朗读
// ============================================================
import { getSettings, deepMerge, hasApiKey } from './settings.js';
import { streamChat } from './llm.js';
import { buildSystemPrompt } from './characters.js';
import { renderMarkdown, escapeHtml } from './markdown.js';
import { iconSvg } from './icons.js';
import { t, getLang } from './i18n.js';
import { createMarkerParser } from './marker-parser.js';
import { createReplyPacer } from './reply-pacer.js';
import { buildStyleInstruction } from './style.js';
import { splitForCompaction, buildContextMessages, buildSummaryRequest, summaryKey, summarizable, DEFAULT_KEEP_TURNS } from './history.js';
import { getLive2dModel, stageMotion, stageExpression } from './stage.js';
import { fillAvatar } from './shell.js';
import { state, hooks, tts } from './state.js';
import { $, toast, scrollBottom, autoGrowInput } from './dom.js';
import { startRun } from '../agent/run.js';
import { createToolRegistry, TOOL_SPECS, withBaseExecutors } from '../agent/tool-registry.js';
import { buildPersonaSystemPrompt, buildTaskMessage, buildToolContext, assertPersonaPreserved } from '../agent/context-engine.js';
import { createAgentBridge, createAgentLlm, isSensitivePath } from './agent-bridge.js';
import { beginAgentTurn, attachAgentController } from './agent-ui.js';
import { normalizeAuthorization } from '../agent/authorization.js';
import { broadcastSession } from './session-coordinator.js';
import { createContextEngine, DEFAULT_BUDGET } from '../context/engine.js';
import { createRetrievalAdapters, ensureEngines } from './memory-host.js';

/**
 * 对话用的 Context Engine 实例（全局一个）。
 *
 * 为什么是单例：它持有最近的组装记录（recentUsage），排查「上下文怎么突然变大了」
 * 时需要一个连续历史；每次新建会把这个线索丢掉。
 *
 * memory / knowledge 通过 `createRetrievalAdapters()` 接进来（长期记忆与知识库）：
 * 引擎只负责「给我候选」，真正的检索、精排、预算都在各自的引擎里。
 * 两边都没配 / 初始化失败时返回空数组，对话照常。
 */
let ctxEngine = null;
function chatContextEngine() {
  if (!ctxEngine) {
    ctxEngine = createContextEngine(Object.assign(
      { budgetOverride: DEFAULT_BUDGET },
      createRetrievalAdapters(),
    ));
  }
  return ctxEngine;
}

/** 自检/测试用：当前上下文预算与最近几次组装的用量 */
export function contextUsage() {
  return ctxEngine ? ctxEngine.recentUsage() : [];
}

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
    // 连续多条助手回复只在第一条显示头像，避免整屏重复头像与边距
    const prev = state.messages[i - 1];
    const showAvatar = !(m.role === 'assistant' && prev && prev.role === 'assistant');
    box.appendChild(makeMsgEl(m.role, m.content, i, i === lastAssistant, showAvatar));
  });
  scrollBottom();
  // 双窗口：主窗口是会话所有者，消息一变就把快照推给展台（只读展示）
  try { broadcastSession('messages'); } catch (err) { /* 展台没开就算了 */ }
}

/**
 * 复制到剪贴板。
 *
 * 为什么先走主进程：`navigator.clipboard` 在 file:// / 无焦点 / 缺权限时会
 * 直接 reject（用户看到的就是「复制失败」）。主进程的 Electron clipboard
 * 不受这些限制，所以先让它写，再退回浏览器 API，最后退回 execCommand。
 */
export async function copyText(text) {
  const value = String(text || '');
  if (!value) { toast(t('chat.copyFailed'), true); return false; }
  const api = window.api || {};
  if (typeof api.writeClipboard === 'function') {
    try {
      await api.writeClipboard(value);
      toast(t('chat.copied'));
      return true;
    } catch (err) { /* 落到下面的兜底 */ }
  }
  try {
    await navigator.clipboard.writeText(value);
    toast(t('chat.copied'));
    return true;
  } catch (err) {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) { toast(t('chat.copied')); return true; }
    } catch (err2) { /* 最终失败 */ }
    toast(t('chat.copyFailed'), true);
    return false;
  }
}

export function speakText(text) {
  if (text) tts.enqueue(String(text), ttsSettingsForCharacter());
}

export function makeMsgEl(role, content, index, isLastAssistant, showAvatar) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  // 助手消息 = 正文排版（不是气泡）；用户消息才是浅玫瑰底色的一块
  if (role === 'assistant' && showAvatar !== false) {
    const av = document.createElement('span');
    av.className = 'msg-avatar';
    av.alt = '';
    const cur = state.current;
    fillAvatar(av, (cur && cur.data && cur.data.name) || 'AILEEN', (cur && cur.data && cur.data.avatar) || '');
    div.appendChild(av);
  }
  // 正文与操作条竖着叠：操作条在**消息下面**（以前浮在右上角，淡出到看不见，
  // 用户反馈「复制图标不好找」）。外面这一层让「气泡 + 操作条」作为一个整体对齐。
  const col = document.createElement('div');
  col.className = 'msg-col';
  const body = document.createElement('div');
  body.className = 'msg-body';
  if (role === 'assistant') {
    body.innerHTML = renderMarkdown(content);
    // 代码块右上角给一个「复制这段代码」：长回复里想复制的往往只是那段。
    // 用一层 wrapper 定位，代码横向滚动时按钮不会跟着跑出去。
    body.querySelectorAll('pre').forEach((pre) => {
      if (!pre.parentNode) return;
      const wrap = document.createElement('div');
      wrap.className = 'code-block';
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      const btn = document.createElement('button');
      btn.className = 'code-copy';
      btn.type = 'button';
      btn.title = t('chat.copyCode');
      btn.innerHTML = iconSvg('copy', 13) + '<span>' + t('chat.copyCode') + '</span>';
      btn.onclick = (e) => {
        e.stopPropagation();
        const code = pre.querySelector('code');
        copyText(code ? code.innerText : pre.innerText);
      };
      wrap.appendChild(btn);
    });
  } else {
    body.textContent = content;
  }
  col.appendChild(body);
  const acts = document.createElement('div');
  acts.className = 'msg-actions';
  // 复制排在最前面：这是最常用的操作，要在「一眼能找到」的位置
  const cp = document.createElement('button');
  cp.className = 'msg-copy';
  cp.innerHTML = iconSvg('copy', 14) + '<span class="msg-copy-label">' + t('chat.copy') + '</span>';
  cp.title = t('chat.copy');
  cp.onclick = () => copyText(content);
  acts.appendChild(cp);
  if (role === 'assistant') {
    const sp = document.createElement('button');
    sp.innerHTML = iconSvg('speaker', 14);
    sp.title = t('chat.readAloud');
    sp.onclick = () => speakText(content);
    acts.appendChild(sp);
  }
  if (isLastAssistant) {
    const rg = document.createElement('button');
    rg.innerHTML = iconSvg('regenerate', 14);
    rg.title = t('chat.regenerate');
    rg.onclick = () => regenerateLast();
    acts.appendChild(rg);
  }
  if (typeof index === 'number') {
    const del = document.createElement('button');
    del.innerHTML = iconSvg('close', 14);
    del.title = t('chat.deleteMsg');
    del.onclick = () => deleteMessage(index);
    acts.appendChild(del);
  }
  col.appendChild(acts);
  div.appendChild(col);
  return div;
}

/** 朗读最后一条助手消息（顶部「更多」菜单用） */
export function speakLast() {
  const text = state.lastAssistantText || String((state.messages || []).filter((m) => m.role === 'assistant').slice(-1)[0] || {}).content || '';
  if (!text) { toast(t('chat.nothingToRead')); return; }
  speakText(text);
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
  const prev = state.messages[state.messages.length - 2];
  const showAvatar = !(role === 'assistant' && prev && prev.role === 'assistant');
  const el = makeMsgEl(role, content, state.messages.length - 1, false, showAvatar);
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
  // 展台的状态提示跟着「在想 / 空闲」走
  try { broadcastSession('status'); } catch (err) { /* 忽略 */ }
  const send = $('btn-send');
  const stop = $('btn-stop');
  const typing = $('typing');
  const input = $('input');
  if (send) {
    send.disabled = b || !String((input && input.value) || '').trim();
    send.classList.toggle('hidden', !!b);
  }
  if (stop) {
    stop.disabled = !b;
    stop.classList.toggle('hidden', !b);
  }
  if (typing) typing.className = 'typing' + (b ? '' : ' hidden');
}

// ---------------- 上下文压缩 / 形象控制 ----------------

// 同一段旧消息只总结一次。
// 上限是必要的：key 现在依赖内容，不会自然复用，长聊下去 Map 会一直涨（内存泄漏）。
const SUMMARY_CACHE_MAX = 64;
const summaryCache = new Map();

function cacheSummary(key, value) {
  summaryCache.set(key, value);
  while (summaryCache.size > SUMMARY_CACHE_MAX) {
    const oldest = summaryCache.keys().next();
    if (oldest.done) break;
    summaryCache.delete(oldest.value);
  }
}

async function ensureSummary(older, settings) {
  if (!summarizable(older)) return '';
  const req = buildSummaryRequest(older, t('prompt.summarySystem'));
  // key 必须覆盖「会影响摘要结果的一切」：这段旧消息本身、角色卡与 persona、
  // 拼好的 system 提示词、界面语言、保留轮数、摘要提示词。
  const cur = state.current;
  const card = cur && cur.data ? cur.data : {};
  const key = summaryKey(older, {
    character: (cur && cur.file) || '',
    persona: String(card.personality || '') + '\u0000' + String(card.system_prompt || ''),
    system: buildSystemPrompt(card),
    lang: getLang(),
    keepTurns: DEFAULT_KEEP_TURNS,
    summarySystem: req.system,
  });
  if (summaryCache.has(key)) return summaryCache.get(key);
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
  if (full) cacheSummary(key, full);
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
  try {
    if (m.kind === 'motion') stageMotion(m.value);
    else if (m.kind === 'expr' || m.kind === 'expression' || m.kind === 'emote') stageExpression(m.value);
  } catch (err) { /* 展台没开就忽略 */ }
}

// ---------------- 对话 ----------------
/**
 * 把一段**已经拿到的完整文本**按回复节奏展示出来：分气泡、落库、朗读、渲染。
 *
 * 为什么不直接 push 一条消息了事：角色回复可能用 <|delay|> 拆成多条、
 * 里面还夹着动作/表情标记，走同一条 pacer 才能和流式回复表现一致。
 * 电脑控制跑完后用它把「角色自己的汇报」放回对话区。
 */
export async function revealReply(text) {
  const shouldSpeak = getSettings().tts.autoPlay;
  const boxEl = $('messages');
  if (!boxEl) return '';
  const segments = [];
  let preview = null;
  let bodyEl = null;
  let curText = '';

  function setTyping(on) {
    const ty = $('typing');
    if (ty) ty.className = 'typing' + (on ? '' : ' hidden');
  }
  function startBubble() {
    curText = '';
    const el = document.createElement('div');
    el.className = 'msg assistant';
    const av = document.createElement('span');
    av.className = 'msg-avatar';
    av.alt = '';
    const cur = state.current;
    fillAvatar(av, (cur && cur.data && cur.data.name) || 'AILEEN', (cur && cur.data && cur.data.avatar) || '');
    const body = document.createElement('div');
    body.className = 'msg-body';
    el.appendChild(av);
    el.appendChild(body);
    boxEl.appendChild(el);
    preview = el;
    bodyEl = body;
  }
  function seal(keepPreview) {
    const t2 = curText.trim();
    curText = '';
    if (!t2) {
      if (!keepPreview && preview && preview.parentNode) preview.parentNode.removeChild(preview);
      preview = null;
      return;
    }
    segments.push(t2);
    state.messages.push({ role: 'assistant', content: t2, at: Date.now() });
    if (shouldSpeak) tts.enqueue(t2, ttsSettingsForCharacter());
    preview = null;
  }

  startBubble();
  const pacer = createReplyPacer({
    onText: (chunk) => {
      if (!preview) startBubble();
      curText += chunk;
      setTyping(false);
      if (bodyEl) bodyEl.innerHTML = renderMarkdown(curText) + '<span class="caret"></span>';
      scrollBottom();
    },
    onStage: (m) => applyStageMarker(m),
    onBreak: () => { seal(false); startBubble(); },
    onDelay: (sec) => { if (sec >= 1.2) setTyping(true); },
  });
  await pacer.push(String(text || ''));
  await pacer.finish();
  setTyping(false);
  seal(true);
  renderMessages();
  scrollBottom();
  const acc = segments.join('\n\n');
  state.lastAssistantText = acc;
  if (state.current) saveChatFor(state.current.file);
  return acc;
}

export async function runAssistantReply(userContent, forceSpeak, image) {
  const cur = state.current;
  if (!cur) throw new Error(t('chat.needChar'));
  const s = getSettings();
  if (!hasApiKey('llm')) throw new Error(t('chat.noApiKey'));
  pushMsg('user', userContent);

  // 最近若干轮原样带上，更早的压成一条摘要（以前是直接 slice(-12) 丢掉，角色会失忆）
  const { older, kept } = splitForCompaction(state.messages, DEFAULT_KEEP_TURNS);
  const summary = await ensureSummary(older, s);

  // **上下文的拼装交给 Context Engine**（唯一入口）。
  // 以前这里是手写的 `[system, ...history]` —— 各个模块都想往 system 里塞东西，
  // 迟早把人设挤掉、或者让 Memory/Tool 结果无限注入。现在只有一条路：
  // 角色人格 → 风格指令 → 摘要 → 对话历史，全部由引擎按预算拼。
  const ctx = await chatContextEngine().buildContext({
    card: cur.data,
    query: userContent,
    messages: kept,
    summary,
    systemExtra: styleInstruction(),
  });
  const msgs = ctx.messages;

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
  let bodyEl = null;
  let curText = '';

  function setTyping(on) {
    const ty = $('typing');
    if (ty) ty.className = 'typing' + (on ? '' : ' hidden');
  }

  function startBubble() {
    curText = '';
    const el = document.createElement('div');
    el.className = 'msg assistant';
    const av = document.createElement('span');
    av.className = 'msg-avatar';
    av.alt = '';
    const cur = state.current;
    fillAvatar(av, (cur && cur.data && cur.data.name) || 'AILEEN', (cur && cur.data && cur.data.avatar) || '');
    const body = document.createElement('div');
    body.className = 'msg-body';
    el.appendChild(av);
    el.appendChild(body);
    boxEl.appendChild(el);
    preview = el;
    bodyEl = body;
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
      if (bodyEl) bodyEl.innerHTML = renderMarkdown(curText) + '<span class="caret"></span>';
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
      // 推理模型会先想几秒再开口。这段时间一个正文增量都没有，
      // 不处理的话界面是死的 —— 让人以为卡住了。
      onReasoning: () => { if (!curText && !segments.length) setTyping(true); },
    });
  } catch (err) {
    streamErr = err;
  }
  await pacer.finish();
  setTyping(false);
  seal(true);

  if (streamErr && !(streamErr.name === 'AbortError') && bodyEl) {
    bodyEl.innerHTML = '<span style="color:var(--danger)">' + iconSvg('info', 14) + ' ' + escapeHtml(String(streamErr.message || streamErr)) + '</span>';
  }
  setBusy(false);
  renderMessages();   // 统一重画：拿到正确的下标与各种消息操作
  scrollBottom();

  const acc = segments.join('\n\n');
  state.lastAssistantText = acc;
  if (state.current) saveChatFor(state.current.file);
  return acc;
}

/**
 * 电脑控制模式的一次对话。
 *
 * 流程就是需求里那条链：
 *   普通对话 → Agent 判断 → Computer Tool → Permission → 执行 → 结果 → 继续对话
 *
 * 三条不可动摇的规矩：
 *   1. **人格来自角色卡**（buildPersonaSystemPrompt 第 0 段就是它），
 *      Agent 只是给这个角色加了行动能力；
 *   2. 工具结果走独立的 tool 消息，**没有写 system 的通路** ——
 *      所以它在结构上不可能覆盖 Character Prompt；
 *   3. 汇报用**当前角色的语气**（同一个 system prompt、同一张卡），
 *      不可能突然变成 "Task completed successfully."。
 */
export async function sendWithAgent(userContent, opts = {}) {
  const cur = state.current;
  if (!cur) throw new Error(t('chat.needChar'));
  if (!hasApiKey('llm')) {
    toast(t('chat.needKeyHint'));
    hooks.openLlmModal();
    return '';
  }
  const resume = opts && opts.checkpoint ? opts.checkpoint : null;
  // 续跑不新增用户气泡（任务还是同一个任务），进度写在新的活动卡里
  if (!resume) pushMsg('user', userContent);

  const s = getSettings();
  const agentCfg = s.agent || {};
  const registry = createToolRegistry();
  registry.registerAll(withBaseExecutors(TOOL_SPECS));
  const tools = registry.list();

  // 工作区 + 环境信息（全部是「外部事实」，与人格无关）
  let workspace = '';
  let cursor = null;
  let screen = null;
  let windows = [];
  try { workspace = ((await window.api.agentWorkspace()) || {}).workspace || ''; } catch { /* 没有就算了 */ }
  try { cursor = await (window.api.agentCursor ? window.api.agentCursor() : null); } catch { cursor = null; }
  try { screen = await window.api.agentScreenshot({ withData: false }); } catch { screen = null; }
  if (agentCfg.computerUse) {
    try {
      const res = await (window.api.agentWindow ? window.api.agentWindow({ op: 'list' }) : null);
      windows = (res && res.titles) || [];
    } catch { windows = []; }
  }

  const { older, kept } = splitForCompaction(state.messages.slice(0, -1), DEFAULT_KEEP_TURNS);
  let summary = '';
  try { summary = await ensureSummary(older, s); } catch { summary = ''; }

  const taskMessage = buildTaskMessage({
    task: userContent,
    toolContext: buildToolContext({ workspace, screen, cursor, windows }),
  });

  // **Agent 也走同一个 Context Engine**（不是另一套拼装）。
  // 之前这里是手写 `buildPersonaSystemPrompt` + `buildContextMessages`，
  // 和聊天路径是两条独立的实现 —— 那正是「各模块各自拼 prompt」的老问题。
  // 现在两条路径共用同一个入口，人格门禁也由引擎内部统一把守。
  const ctx = await chatContextEngine().buildContext({
    card: cur.data,
    query: userContent,
    messages: kept,
    summary,
    systemExtra: styleInstruction(),
    agent: {
      enabled: true,
      task: userContent,
      workspace,
      tools,
    },
  });
  const systemPrompt = ctx.messages.find((m) => m && m.role === 'system').content;
  // 双保险：引擎内部已经断言过，这里再确认一次（Agent 一旦没有人格就不是那个角色了）
  assertPersonaPreserved(cur.data, systemPrompt);

  setBusy(true);
  state.abortCtrl = new AbortController();
  // 这一轮的活动卡先挂进对话里：Agent 干活的每一步都长在这条消息上，
  // 不另开侧边控制台（用户明确要求过）。
  beginAgentTurn(userContent);

  const started = startRun({
    task: userContent,
    taskMessage,
    systemPrompt,          // ← 人格从这里进去，且只在开头出现一次
    workspace,
    registry,
    llm: createAgentLlm(getSettings),
    bridge: createAgentBridge(),
    isSensitive: isSensitivePath,
    permissionConfig: { requireMedium: agentCfg.requireMedium !== false },
    // 0.8：授权（模式 / 范围 / 有效期）+ 预算 + 恢复策略，全部来自设置
    authorization: normalizeAuthorization(agentCfg.authorization || {}, { now: Date.now() }),
    maxRounds: agentCfg.maxRounds,
    roundBudget: agentCfg.roundBudget,
    maxRetries: agentCfg.maxRetries,
    parallelReadOnly: agentCfg.readOnlyParallel !== false,
    checkpoint: resume || undefined,
    history: ctx.messages.filter((m) => m.role !== 'system'),
    // 每一轮请求也由 Context Engine 组装（工具结果/历史都按预算裁），
    // 而不是让 runtime 再拼一遍 —— 再多一条拼装路径就等于没统一。
    buildRequest: ({ systemPrompt: sys, history, messages }) => {
      const trimmed = history.concat(messages);
      return [{ role: 'system', content: sys }]
        .concat(trimmed.filter((m) => m && m.role && m.role !== 'system'));
    },
    signal: state.abortCtrl.signal,
    onEvent: (type, payload) => {
      // 事件交给界面层（对话内的活动卡 + 任务页），runtime 不认识它们
      if (typeof hooks.agentEvent === 'function') hooks.agentEvent(type, payload);
    },
  });

  // 控制器与状态总线交给对话内活动卡：暂停/继续/取消/审批都要它，
  // Live2D 的动作表情也由它订阅（角色边干边演）。
  attachAgentController(started.controller, started.bus);

  let answer = '';
  let failure = '';
  try {
    const api = await started.done;
    answer = String((api.run && api.run.answer) || '').trim();
    if (api.run && api.run.error) failure = String(api.run.error);
    // 预算用尽：把检查点存起来，活动卡上的「继续执行」用它断点续跑
    if (api.budget && api.budget.canContinue) {
      state.pendingCheckpoint = api.checkpoint('budget');
      state.pendingCheckpointTask = userContent;
    } else if (api.run && api.run.status === 'completed') {
      state.pendingCheckpoint = null;
      state.pendingCheckpointTask = '';
    }
  } catch (err) {    failure = String((err && err.message) || err);
  } finally {
    state.abortCtrl = null;
  }

  // 角色自己的汇报回到对话框；工具日志留在**同一轮的活动卡**里（不另开控制台）
  if (answer) {
    await revealReply(answer);
  } else if (failure) {
    toast(failure, true);
  }
  setBusy(false);
  return answer;
}

/**
 * 断点续跑：用上一次的检查点重开一次任务。
 * **不新增用户气泡**（任务没变），进度由 runtime 通过检查点摘要注入。
 */
export async function resumeWithAgent(checkpoint) {
  const cp = checkpoint && checkpoint.checkpoint ? checkpoint : state.pendingCheckpoint;
  if (!cp) return '';
  const task = String(cp.task || state.pendingCheckpointTask || '').trim();
  if (!task) return '';
  return sendWithAgent(task, { checkpoint: cp });
}

export async function send(text) {
  const content = String(text || '').trim();
  const image = state.pendingImage;
  if ((!content && !image) || state.busy) return;
  const s = getSettings();
  if (!hasApiKey('llm')) {
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
    // 开了电脑控制、且这条消息不是纯图片 → 走 Agent（Chat 是入口，Agent 是能力）
    if (s.agent && s.agent.computerUse && content && !image) {
      await sendWithAgent(content);
    } else {
      await runAssistantReply(content || t('chat.visionPrompt'), false, image);
    }
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

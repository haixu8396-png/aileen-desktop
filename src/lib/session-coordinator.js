// ============================================================
// 双窗口会话协调器（主窗口侧，**唯一所有者**）
//
// 规则（对应 0.8 的需求）：
//   1) 两个窗口共享**同一套**消息/角色状态：主窗口是唯一所有者，
//      展台只做只读展示 + 把用户输入转交回来。绝不允许两边各自维护一份对话。
//   2) 发送统一走这里 → chat.js 的 send()：state.busy 已经在 send 里拦重复请求，
//      所以「语音一轮 + 打字一条」同时发生时不会发两次。
//   3) 通过受控 IPC 通信（主进程转发），渲染窗口不直接碰对方对象；API Key 仍在主进程。
//   4) 生命周期：展台创建/重开时它会发 `sync` 请求，这里回一份完整快照。
//
// 事件类型（与 shared/ipc-schemas.cjs 的 overlay:session / overlay:request 对应）
//   主窗口 → 展台：messages / status / character / models
//   展台 → 主窗口：sync / chat / voice / model / motion / expression / openMain
// ============================================================
import { state } from './state.js';
import { t } from './i18n.js';

/** 主窗口最多广播多少条消息（展台只显示最近几条，不需要全量） */
const MAX_BROADCAST_MESSAGES = 20;

let handlers = {
  onChat: null,
  onVoice: null,
  onModel: null,
  onModelList: null,
};
/** 最近一次广播的「状态」，避免同样的内容反复发（展台那边也就不必反复重画） */
let lastStatusKey = '';

/** 清洗消息：只保留 role + 纯文本，避免把 DOM/HTML 带到另一个窗口 */
function sanitizeMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  for (const m of list.slice(-MAX_BROADCAST_MESSAGES)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const text = String(m.content == null ? '' : m.content);
    out.push({ role: m.role, text: text.slice(0, 4000) });
  }
  return out;
}

/**
 * 初始化：只注册一次。
 * @param {object} h { onChat(text), onVoice(), onModel(index), onModelList() }
 */
export function initSessionCoordinator(h = {}) {
  handlers = Object.assign({ onChat: null, onVoice: null, onModel: null, onModelList: null }, h || {});
  const api = window.api || {};
  if (typeof api.onOverlayRequest !== 'function') return false;
  api.onOverlayRequest((req) => {
    if (!req || !req.type) return;
    try {
      handleRequest(req);
    } catch (err) {
      console.warn('[session] 处理展台请求失败：', err && err.message);
    }
  });
  return true;
}

function handleRequest(req) {
  switch (req.type) {
    case 'sync':
      // 展台刚建好/重开：把所有状态推一遍
      lastStatusKey = '';
      broadcastSession('messages');
      broadcastSession('status');
      broadcastSession('character');
      if (typeof handlers.onModelList === 'function') handlers.onModelList();
      break;
    case 'chat': {
      const text = String(req.text || '').trim();
      // 空消息直接忽略；send() 内部还有 state.busy 拦重复
      if (text && typeof handlers.onChat === 'function') handlers.onChat(text);
      break;
    }
    case 'voice':
      if (typeof handlers.onVoice === 'function') handlers.onVoice();
      break;
    case 'model':
      if (typeof handlers.onModel === 'function') handlers.onModel(Number(req.index) || 0);
      break;
    case 'openMain':
      // 主进程直接处理（overlay:openMain），这里不需要动作
      break;
    default:
      break;
  }
}

/** 把当前状态推给展台 */
export function broadcastSession(kind) {
  const api = window.api || {};
  if (typeof api.overlaySendSession !== 'function') return false;
  try {
    if (kind === 'messages') {
      api.overlaySendSession({ type: 'messages', messages: sanitizeMessages(state.messages) });
      return true;
    }
    if (kind === 'character') {
      const cur = state.current;
      api.overlaySendSession({
        type: 'character',
        character: { name: cur && cur.data ? String(cur.data.name || '') : '' },
      });
      return true;
    }
    if (kind === 'models') {
      api.overlaySendSession({
        type: 'models',
        models: (state.models || []).slice(0, 100).map((m) => ({ name: String((m && m.name) || '') })),
      });
      return true;
    }
    if (kind === 'status') {
      const busy = !!state.busy;
      const voice = !!state.voiceLoop;
      const agent = state.agentStatus || 'idle';
      const key = [busy, voice, agent].join('|');
      if (key === lastStatusKey) return false;   // 同样的状态不重复发
      lastStatusKey = key;
      api.overlaySendSession({
        type: 'status',
        status: {
          busy,
          voice,
          agent,
          label: statusLabel({ busy, voice, agent }),
        },
      });
      return true;
    }
  } catch (err) {
    console.warn('[session] 广播失败：', err && err.message);
  }
  return false;
}

function statusLabel(s) {
  if (s.agent && s.agent !== 'idle') {
    if (s.agent === 'waiting_approval') return t('overlay.statusApproval');
    if (s.agent === 'thinking' || s.agent === 'planning') return t('overlay.statusThinking');
    if (s.agent === 'using_tool' || s.agent === 'working') return t('overlay.statusWorking');
    if (s.agent === 'success' || s.agent === 'completed') return t('overlay.statusDone');
    if (s.agent === 'error' || s.agent === 'failed') return t('overlay.statusError');
  }
  if (s.voice) return t('overlay.statusListening');
  if (s.busy) return t('overlay.statusThinking');
  return t('overlay.statusIdle');
}

// LLM 对话：渲染层这一侧现在只是**代理**。
//
// 为什么改：以前这里直接 fetch /chat/completions，密钥必须存在页面里，
// window.api.getSettings() 就能读到 —— 任何注入脚本都能把 Key 取走。
// 现在真正的请求在主进程发出（shared/llm.cjs + shared/ai-ipc.cjs），
// 渲染层只送「消息 + 非敏感参数」，拿回增量事件。
//
// 对外接口保持不变（messages/settings/signal/onDelta/onReasoning/onFinish），
// 所以 chat / chess / minecraft / persona 这些调用方一行都不用改。
import { t } from './i18n.js';

function makeRequestId() {
  try {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  } catch (err) { /* 忽略，走下面的兜底 */ }
  return 'llm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/** 主进程只回错误码，文案在当前语言里生成（这样切语言不用重发请求） */
function localizedError(msg) {
  const code = msg && msg.code;
  if (code === 'NO_KEY') return Object.assign(new Error(t('llm.needKey')), { code });
  if (code === 'ABORTED') return Object.assign(new Error('aborted'), { name: 'AbortError', code });
  if (code === 'EMPTY_REPLY') {
    const budget = Number(msg.budget) || 0;
    const text = msg.reasoningChars > 0
      ? t('llm.onlyReasoning', { n: budget })
      : (msg.streamError ? t('llm.streamFailed', { v: msg.streamError })
        : (msg.finishReason === 'length' ? t('llm.hitLimit', { n: budget }) : t('llm.emptyReply')));
    return Object.assign(new Error(text), {
      code,
      reasoningChars: msg.reasoningChars,
      finishReason: msg.finishReason,
    });
  }
  return Object.assign(new Error((msg && msg.message) || 'LLM error'), { code, status: msg && msg.status });
}

export async function streamChat({ messages, settings, signal, tools, onDelta, onReasoning, onFinish }) {
  const requestId = makeRequestId();
  const llm = (settings && settings.llm) || {};
  let settled = false;
  let off = null;
  const done = new Promise((resolve, reject) => {
    off = window.api.onLlmChunk((msg) => {
      if (!msg || msg.requestId !== requestId || settled) return;
      if (msg.type === 'delta') { if (onDelta) onDelta(msg.text); return; }
      if (msg.type === 'reasoning') { if (onReasoning) onReasoning(msg.text); return; }
      if (msg.type === 'finish') {
        settled = true;
        if (typeof onFinish === 'function') {
          try {
            onFinish({
              finishReason: msg.finishReason,
              contentChars: msg.contentChars,
              reasoningChars: msg.reasoningChars,
            });
          } catch (err) { /* 回调里的错不该影响通话 */ }
        }
        // toolCalls 由主进程累积好（流式分片已按 index 拼回），原样交给调用方
        resolve({ finishReason: msg.finishReason, toolCalls: msg.toolCalls || [] });
        return;
      }
      if (msg.type === 'error') { settled = true; reject(localizedError(msg)); }
    });
  });
  // 万一主进程直接抛（比如没配 Key），下面 await llmStream 会先抛，
  // done 就再没人接了 —— 挂一个空 catch，避免变成 unhandled rejection。
  done.catch(() => {});

  const abort = () => { window.api.llmAbort(requestId).catch(() => {}); };
  if (signal) {
    if (signal.aborted) {
      if (off) off();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    signal.addEventListener('abort', abort, { once: true });
  }
  try {
    await window.api.llmStream({
      requestId,
      messages,
      tools: Array.isArray(tools) && tools.length ? tools : undefined,
      llm: {
        baseUrl: llm.baseUrl,
        model: llm.model,
        temperature: llm.temperature,
        maxTokens: llm.maxTokens,
      },
    });
    return await done;
  } finally {
    if (off) off();
    if (signal) signal.removeEventListener('abort', abort);
  }
}

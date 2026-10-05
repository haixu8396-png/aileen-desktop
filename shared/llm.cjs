'use strict';
// ============================================================
// LLM SSE 解析核心（Main Process 使用）
//
// 为什么放在 shared/ 而不是 src/lib/：
//   API Key 不允许出现在渲染层，所以真正的网络请求必须在主进程发出。
//   渲染层的 src/lib/llm.js 现在只是一层 IPC 代理，解析逻辑在下面这一份里。
//
// 三个跟真实服务端有关的坑（都踩过）：
//   1) 推理模型先吐 delta.reasoning_content，delta.content 长时间是 null ——
//      必须把思考增量单独交给上层，否则界面在思考期间完全没反应。
//   2) max_tokens 是「思考 + 回答」的总预算，被思考吃光时 finish_reason=length
//      而 content 一个字都没有 —— 这时必须抛错，不能安静地返回空串。
//   3) 带了 tools 时，模型可能「只调工具、一个字正文都不写」
//      （contentChars === 0 但 tool_calls 有货）—— 这不是空回复，不能报错。
//      工具调用的增量是**按 index 分片**下发的，必须按 index 累积。
// ============================================================

function trimBase(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

/**
 * 累积一次 tool_calls 增量。
 * OpenAI 兼容的流式格式长这样（按 index 分片，name 与 arguments 都可能被切开）：
 *   {"index":0,"id":"call_x","function":{"name":"read_file","arguments":"{\"pa"}}
 *   {"index":0,"function":{"arguments":"th\":\"a.js\"}"}}
 */
function accumulateToolCalls(acc, list) {
  for (const tc of list) {
    if (!tc || typeof tc !== 'object') continue;
    const idx = Number.isInteger(tc.index) ? tc.index : acc.length;
    if (!acc[idx]) acc[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
    const slot = acc[idx];
    if (tc.id) slot.id = String(tc.id);
    if (tc.type) slot.type = String(tc.type);
    const fn = tc.function || {};
    if (fn.name) slot.function.name += String(fn.name);
    if (fn.arguments) slot.function.arguments += String(fn.arguments);
  }
  return acc;
}

/** 去掉累积过程中的空槽（模型偶尔会跳 index） */
function compactToolCalls(acc) {
  return (acc || []).filter((c) => c && c.function && (c.function.name || c.function.arguments));
}

/**
 * 流式对话。错误统一带 code，便于上层做本地化文案：
 *   NO_KEY        —— 没配 API Key
 *   HTTP_ERROR    —— 服务端返回非 2xx（带 status / detail）
 *   EMPTY_REPLY   —— 一个字都没写出来（带 reasoningChars / finishReason）
 *   ABORTED       —— 被取消
 *
 * @returns {{finishReason, contentChars, reasoningChars, budget, toolCalls}}
 */
async function streamChatCore({
  baseUrl, apiKey, model, temperature, maxTokens, messages, tools,
  signal, onDelta, onReasoning, onFinish,
}) {
  if (!apiKey) {
    const e = new Error('missing api key');
    e.code = 'NO_KEY';
    throw e;
  }
  const budget = Number(maxTokens) || 1024;
  const url = trimBase(baseUrl) + '/chat/completions';
  const body = {
    model,
    messages,
    temperature: Number(temperature) || 0.8,
    max_tokens: budget,
    stream: true,
  };
  // 只有真的要调工具时才带 tools —— 普通对话带上它反而会让模型话变少
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
      const e = new Error('aborted');
      e.code = 'ABORTED';
      throw e;
    }
    throw err;
  }
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    const e = new Error('HTTP ' + res.status + ' ' + detail.slice(0, 240));
    e.code = 'HTTP_ERROR';
    e.status = res.status;
    e.detail = detail.slice(0, 240);
    throw e;
  }

  let contentChars = 0;
  let reasoningChars = 0;
  let finishReason = '';
  let lastError = null;
  let streamDone = false;
  const toolAcc = [];

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (signal && signal.aborted) {
        const e = new Error('aborted');
        e.code = 'ABORTED';
        throw e;
      }
      throw err;
    }
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { streamDone = true; break; }
      try {
        const j = JSON.parse(data);
        if (j && j.error) { lastError = j.error.message || 'stream error'; continue; }
        const choice = j.choices && j.choices[0];
        if (!choice) continue;
        const d = choice.delta || {};
        if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
          reasoningChars += d.reasoning_content.length;
          if (onReasoning) onReasoning(d.reasoning_content);
        }
        if (typeof d.content === 'string' && d.content.length > 0) {
          contentChars += d.content.length;
          if (onDelta) onDelta(d.content);
        }
        if (Array.isArray(d.tool_calls) && d.tool_calls.length) {
          accumulateToolCalls(toolAcc, d.tool_calls);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      } catch { /* partial json */ }
    }
    if (streamDone) break;
  }

  const toolCalls = compactToolCalls(toolAcc);
  const info = { finishReason, contentChars, reasoningChars, budget, toolCalls };
  if (typeof onFinish === 'function') {
    try { onFinish(info); } catch { /* 回调出错不影响主流程 */ }
  }

  // 只调工具、正文为空：这是合法的一轮，不是空回复
  if (contentChars === 0 && toolCalls.length === 0) {
    const e = new Error('empty reply');
    e.code = 'EMPTY_REPLY';
    e.reasoningChars = reasoningChars;
    e.finishReason = finishReason;
    e.budget = budget;
    e.streamError = lastError;
    throw e;
  }
  return info;
}

module.exports = { streamChatCore, trimBase, accumulateToolCalls, compactToolCalls };

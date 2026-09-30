// LLM 对话：OpenAI 兼容 /chat/completions，SSE 流式输出
//
// 两个跟推理模型（deepseek-reasoner 这一类）有关、但很容易被忽略的坑：
//
//   1) 推理模型先吐 `delta.reasoning_content`（思考过程），`delta.content` 会长时间是 null。
//      只认 content 的话，界面在思考那几秒里完全不动 —— 用户看到的是「卡住了」。
//      所以这里把思考增量单独通过 onReasoning 交给上层，让界面能说「正在思考」。
//
//   2) `max_tokens` 是「思考 + 回答」的总预算。预算被思考吃光时，`finish_reason` 是
//      `length` 而 content 一个字都没有 —— 老代码会安静地返回空串，用户只看到一个
//      空气泡，完全不知道发生了什么。这里宁可抛错，让上层把原因和怎么改说清楚。
import { t } from './i18n.js';

export async function streamChat({ messages, settings, signal, onDelta, onReasoning }) {
  const { baseUrl, apiKey, model, temperature, maxTokens } = settings.llm;
  if (!apiKey) throw new Error(t('llm.needKey'));
  const budget = Number(maxTokens) || 1024;
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: Number(temperature) || 0.8,
      max_tokens: budget,
      stream: true,
    }),
    signal,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    throw new Error('HTTP ' + res.status + ' ' + detail.slice(0, 240));
  }

  let contentChars = 0;
  let reasoningChars = 0;
  let finishReason = '';
  let lastError = null;
  let streamDone = false;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
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
          onDelta(d.content);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      } catch { /* partial json */ }
    }
    if (streamDone) break;
  }

  // 一个字都没写出来：绝不能安静地返回空串，那样用户只会看到一个空气泡
  if (contentChars === 0) {
    const err = new Error(
      reasoningChars > 0
        ? t('llm.onlyReasoning', { n: budget })
        : (lastError ? t('llm.streamFailed', { v: lastError })
          : (finishReason === 'length' ? t('llm.hitLimit', { n: budget }) : t('llm.emptyReply'))),
    );
    err.code = 'EMPTY_REPLY';
    err.reasoningChars = reasoningChars;
    err.finishReason = finishReason;
    throw err;
  }
}

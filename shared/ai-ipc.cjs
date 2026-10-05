'use strict';
// ============================================================
// AI 网络请求（LLM / TTS / STT）—— 全部在主进程发出
//
// 为什么必须在这里：这些请求都要带 API Key。以前渲染层直接 fetch，
// 于是密钥必须留在页面里（window.api.getSettings() 就能读到），
// 任何注入或被利用的脚本都能把 Key 取走。现在密钥只存在于主进程，
// 渲染层只负责「说要什么」，拿回的是结果（文本 / 音频字节）。
//
// 依赖由 main.js 注入，避免这里反过来 require 主进程的模块。
// ============================================================

async function safeText(res) {
  try { return String(await res.text()).slice(0, 200); } catch { return ''; }
}

function registerAiIpc(deps) {
  const { handle, getSettings, trimBase, streamChatCore, xiaomiAsrLang } = deps;
  const log = deps.log || (() => {});
  const llmRuns = new Map();   // requestId -> AbortController

  /** 取用哪个 Key：允许渲染层临时传入（设置页里「先测试再保存」），否则用已保存的 */
  function pickKey(provided, stored) {
    const p = typeof provided === 'string' ? provided.trim() : '';
    return p || String(stored || '');
  }

  // ---- LLM 流式对话 ----
  // 增量通过 'llm:chunk' 事件回推，invoke 只做「已开始」的确认：
  // 这样 abort 之后不会留下一个永远 pending 的 invoke。
  handle('llm:stream', (event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const requestId = String(p.requestId || '');
    if (!requestId) throw new Error('llm:stream 缺少 requestId');
    const messages = Array.isArray(p.messages) ? p.messages.slice(0, 200) : [];
    if (!messages.length) throw new Error('llm:stream 缺少 messages');
    // Agent 的工具清单（可选）：普通对话不带，带了会挤占正文
    const tools = Array.isArray(p.tools) && p.tools.length ? p.tools.slice(0, 40) : null;
    const sender = event.sender;
    const stored = (getSettings().llm) || {};
    const over = p.llm && typeof p.llm === 'object' ? p.llm : {};
    const ctrl = new AbortController();
    llmRuns.set(requestId, ctrl);
    const send = (msg) => {
      try {
        if (!sender.isDestroyed()) sender.send('llm:chunk', Object.assign({ requestId }, msg));
      } catch (err) { log('推送增量失败（窗口可能已关闭）', err && err.message); }
    };
    streamChatCore({
      baseUrl: over.baseUrl || stored.baseUrl,
      apiKey: stored.apiKey,
      model: over.model || stored.model,
      temperature: over.temperature == null ? stored.temperature : over.temperature,
      maxTokens: over.maxTokens == null ? stored.maxTokens : over.maxTokens,
      messages,
      tools,
      signal: ctrl.signal,
      onDelta: (text) => send({ type: 'delta', text }),
      onReasoning: (text) => send({ type: 'reasoning', text }),
    }).then((info) => send({
      type: 'finish',
      finishReason: info.finishReason,
      contentChars: info.contentChars,
      reasoningChars: info.reasoningChars,
      budget: info.budget,
      toolCalls: info.toolCalls || [],
    })).catch((err) => send({
      type: 'error',
      code: (err && err.code) || 'UNKNOWN',
      message: String((err && err.message) || err),
      status: err && err.status,
      detail: err && err.detail,
      reasoningChars: err && err.reasoningChars,
      finishReason: err && err.finishReason,
      budget: err && err.budget,
      streamError: err && err.streamError,
    })).finally(() => { llmRuns.delete(requestId); });
    return { accepted: true };
  });

  handle('llm:abort', (_e, requestId) => {
    const ctrl = llmRuns.get(String(requestId || ''));
    if (ctrl) ctrl.abort();
    return !!ctrl;
  });

  // ---- 模型列表 / 连通性（以前在渲染层 fetch，等于把 Key 放进页面）----
  handle('llm:listModels', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const stored = (getSettings().llm) || {};
    const baseUrl = trimBase(p.baseUrl || stored.baseUrl);
    if (!baseUrl) throw new Error('缺少 Base URL');
    const key = pickKey(p.apiKey, stored.apiKey);
    const res = await fetch(baseUrl + '/models', { headers: key ? { Authorization: 'Bearer ' + key } : {} });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const ids = (j && j.data ? j.data : []).map((m) => (m && (m.id || m)) || '').filter(Boolean);
    if (!ids.length) throw new Error('no models');
    return ids;
  });

  handle('llm:test', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const stored = (getSettings().llm) || {};
    const baseUrl = trimBase(p.baseUrl || stored.baseUrl);
    if (!baseUrl) throw new Error('缺少 Base URL');
    const key = pickKey(p.apiKey, stored.apiKey);
    const res = await fetch(baseUrl + '/models', { headers: key ? { Authorization: 'Bearer ' + key } : {} });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return { ok: true };
  });

  // ---- TTS：取音频字节，渲染层只负责解码播放 ----
  handle('tts:fetchAudio', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const text = String(p.text || '');
    if (!text) throw new Error('缺少要朗读的文本');
    const s = (getSettings().tts) || {};
    const provider = String(p.provider || s.provider || 'web');
    const key = s.apiKey;
    if (provider === 'openai') {
      if (!key) throw new Error('TTS（OpenAI 兼容）未配置 API Key');
      const res = await fetch(trimBase(s.baseUrl || 'https://api.openai.com/v1') + '/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model: s.model || 'tts-1',
          voice: s.voice || 'alloy',
          input: text,
          response_format: 'mp3',
          speed: Math.min(4, Math.max(0.25, Number(s.rate) || 1)),
        }),
      });
      if (!res.ok) throw new Error('TTS HTTP ' + res.status + ' ' + (await safeText(res)));
      return Buffer.from(await res.arrayBuffer());
    }
    if (provider === 'fish') {
      if (!key) throw new Error('TTS（Fish Audio）未配置 API Key');
      const body = { text, format: 'mp3', latency: 'normal' };
      if (s.voice) body.reference_id = s.voice;
      body.prosody = { speed: Math.min(2, Math.max(0.5, Number(s.rate) || 1)) };
      const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key };
      if (s.model && s.model !== 'tts-1') headers.model = s.model;
      const res = await fetch('https://api.fish.audio/v1/tts', { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) throw new Error('TTS HTTP ' + res.status + ' ' + (await safeText(res)));
      return Buffer.from(await res.arrayBuffer());
    }
    if (provider === 'xiaomi') {
      if (!key) throw new Error('TTS（小米 MiMo）未配置 API Key');
      const res = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model: s.model && s.model !== 'tts-1' ? s.model : 'mimo-v2.5-tts',
          messages: [
            { role: 'user', content: '请用自然、富有感情的语气朗读以下内容。' },
            { role: 'assistant', content: text },
          ],
          audio: { format: 'mp3', voice: s.voice || 'mimo_default' },
        }),
      });
      if (!res.ok) throw new Error('小米 TTS HTTP ' + res.status + ' ' + (await safeText(res)));
      const j = await res.json();
      const msg = j && j.choices && j.choices[0] && j.choices[0].message;
      const b64 = msg && msg.audio && (msg.audio.data || msg.audio.base64);
      if (!b64) throw new Error('小米 TTS 响应中未找到音频数据');
      return Buffer.from(String(b64), 'base64');
    }
    throw new Error('未知的 TTS 提供方: ' + provider);
  });

  // ---- TTS 音色列表（只有 Fish 需要联网问）----
  handle('tts:listVoices', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const stored = (getSettings().tts) || {};
    const key = pickKey(p.apiKey, stored.apiKey);
    if (!key) throw new Error('缺少 API Key');
    const res = await fetch('https://api.fish.audio/v1/voices', { headers: { Authorization: 'Bearer ' + key } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const items = (j.data || j.voices || [])
      .map((v) => (v._id || v.id || '') + ' · ' + (v.title || v.name || ''))
      .filter(Boolean);
    if (!items.length) throw new Error('账号下没有可用音色');
    return items;
  });

  // ---- STT：渲染层负责录音，音频交给主进程去发请求 ----
  handle('stt:transcribe', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const s = (getSettings().stt) || {};
    const provider = String(p.provider || s.provider || 'openai');
    const format = p.format === 'wav' ? 'wav' : 'webm';
    const dataBase64 = String(p.dataBase64 || '');
    if (!dataBase64) throw new Error('缺少音频数据');
    const language = String(p.language || s.language || 'auto');
    const model = String(p.model || s.model || '');
    if (!s.apiKey) throw new Error(provider === 'xiaomi' ? 'STT（小米）未配置 API Key' : 'STT 未配置 API Key');

    if (provider === 'xiaomi') {
      const mime = format === 'wav' ? 'audio/wav' : 'audio/mpeg';
      const res = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.apiKey },
        body: JSON.stringify({
          model: model || 'mimo-v2.5-asr',
          messages: [{
            role: 'user',
            content: [{
              type: 'input_audio',
              input_audio: { data: 'data:' + mime + ';base64,' + dataBase64, format },
            }],
          }],
          asr_options: { language: xiaomiAsrLang(language) },
          stream: false,
        }),
      });
      if (!res.ok) throw new Error('小米 ASR HTTP ' + res.status + ' ' + (await safeText(res)));
      const j = await res.json();
      const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!text) throw new Error('小米 ASR 未返回识别文本');
      return { text: String(text) };
    }

    // openai 兼容：multipart/form-data
    const fd = new FormData();
    const mime = format === 'wav' ? 'audio/wav' : 'audio/webm';
    fd.append('file', new Blob([Buffer.from(dataBase64, 'base64')], { type: mime }), 'recording.' + format);
    fd.append('model', model || 'whisper-1');
    if (language && language !== 'auto') fd.append('language', language);
    const res = await fetch(trimBase(s.baseUrl || 'https://api.openai.com/v1') + '/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + s.apiKey },
      body: fd,
    });
    if (!res.ok) throw new Error('STT HTTP ' + res.status + ' ' + (await safeText(res)));
    const j = await res.json();
    return { text: String((j && (j.text || j.output)) || '') };
  });

  // ---- STT 模型列表 ----
  handle('stt:listModels', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const stored = (getSettings().stt) || {};
    const baseUrl = trimBase(p.baseUrl || stored.baseUrl || 'https://api.openai.com/v1');
    const key = pickKey(p.apiKey, stored.apiKey);
    const res = await fetch(baseUrl + '/models', { headers: key ? { Authorization: 'Bearer ' + key } : {} });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const ids = (j && j.data ? j.data : []).map((m) => (m && (m.id || m)) || '').filter(Boolean);
    if (!ids.length) throw new Error('no models');
    return ids;
  });
}

module.exports = { registerAiIpc };

'use strict';
// ============================================================
// 嵌入模型（Embedding）—— 设置里的「获取模型 / 测试连接」
//
// 为什么单独一份而不是塞进 ai-ipc：
//   · LLM/TTS/STT 是「对话链路」，embedding 是「记忆与知识库的检索链路」，
//     两者的配置分组、失败语义、调用频率都不一样；
//   · embedding 的 Key 存在 settings.embedding.apiKey，与对话用的 Key 分开
//     （用户可能想用便宜的小模型算向量）。
//
// 安全约定与其它服务一致：**Key 只在主进程里用**，渲染层送/收的都不含明文。
// 请求体构造走 shared/embeddings.cjs，与真正做检索时是同一份代码。
// ============================================================
const { buildEmbedRequest, parseEmbedResponse } = require('./embeddings.cjs');

function registerEmbeddingIpc(deps) {
  const { handle, getSettings, log = () => {} } = deps;

  /** 取这次要用的配置：允许渲染层临时覆盖（设置页里「先测再存」） */
  function pickConfig(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const stored = (getSettings() || {}).embedding || {};
    const typedKey = typeof p.apiKey === 'string' ? p.apiKey.trim() : '';
    return {
      baseUrl: String(p.baseUrl || stored.baseUrl || '').trim(),
      apiKey: typedKey || String(stored.apiKey || ''),
      model: String(p.model || stored.model || '').trim(),
    };
  }

  // 拉起模型列表（OpenAI 兼容的 GET /models）
  handle('embedding:listModels', async (_e, payload) => {
    const cfg = pickConfig(payload);
    if (!cfg.baseUrl) throw new Error('缺少 Base URL');
    const url = cfg.baseUrl.replace(/\/+$/, '') + '/models';
    const res = await fetch(url, {
      headers: cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {},
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const ids = (json && json.data ? json.data : [])
      .map((m) => (m && (m.id || m.name || m)) || '')
      .filter(Boolean);
    if (!ids.length) throw new Error('这个服务没有返回任何模型');
    // 只留下看起来像嵌入模型的，省得用户在一堆对话模型里翻
    const embedish = ids.filter((id) => /embed|bge|m3|gte|text-embedding|nomic/i.test(id));
    return { models: ids, suggested: embedish.length ? embedish : ids };
  });

  // 真的算向量：渲染层的记忆/知识库引擎通过这条通道拿向量 ——
  // Key 只在主进程用，渲染层送文本、收向量，中间看不到密钥。
  handle('embedding:embed', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const texts = Array.isArray(p.texts) ? p.texts.slice(0, 64).map((t) => String(t == null ? '' : t)) : [];
    if (!texts.length) throw new Error('没有要计算向量的文本');
    const cfg = pickConfig(p);
    if (!cfg.baseUrl) throw new Error('缺少 Base URL');
    if (!cfg.apiKey) throw new Error('缺少 API Key');
    if (!cfg.model) throw new Error('缺少模型名');
    const req = buildEmbedRequest({ baseUrl: cfg.baseUrl, model: cfg.model, input: texts });
    const res = await fetch(req.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify(req.body),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = String(await res.text()).slice(0, 200); } catch { /* 忽略 */ }
      throw new Error('HTTP ' + res.status + (detail ? ' ' + detail : ''));
    }
    const vecs = parseEmbedResponse(await res.json());
    if (vecs.length !== texts.length) throw new Error('返回的向量条数与请求不一致');
    return { vectors: vecs, dimensions: vecs[0].length };
  });

  // 真的算一次向量：比 GET /models 更能说明问题（有些服务列得出模型但算不了）
  handle('embedding:test', async (_e, payload) => {
    const cfg = pickConfig(payload);
    if (!cfg.baseUrl) throw new Error('缺少 Base URL');
    if (!cfg.apiKey) throw new Error('缺少 API Key');
    if (!cfg.model) throw new Error('缺少模型名');
    const req = buildEmbedRequest({ baseUrl: cfg.baseUrl, model: cfg.model, input: ['连通性测试'] });
    const res = await fetch(req.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify(req.body),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = String(await res.text()).slice(0, 200); } catch { /* 忽略 */ }
      throw new Error('HTTP ' + res.status + (detail ? ' ' + detail : ''));
    }
    const json = await res.json();
    let vecs;
    try {
      vecs = parseEmbedResponse(json);
    } catch (err) {
      throw new Error('返回内容不是合法的 embedding：' + ((err && err.message) || err));
    }
    log('embedding 连通性测试通过，维度 ' + vecs[0].length);
    return { ok: true, dimensions: vecs[0].length };
  });
}

module.exports = { registerEmbeddingIpc };

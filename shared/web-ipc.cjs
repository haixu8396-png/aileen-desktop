'use strict';
// ============================================================
// 联网能力 IPC（主进程）
//
// 通道（全部走 validatedHandle，参数有 schema）：
//   web:fetch        抓一个 URL（SSRF 防护在 web-fetch.cjs 里）
//   web:capabilities 读当前 provider 的联网能力（缓存，未探测 = unknown）
//   web:probe        真发一次最小请求探测能力（要 Key：Key 只在主进程用）
// ============================================================

const dns = require('node:dns');
const webFetch = require('./web-fetch.cjs');
const webCaps = require('./web-capabilities.cjs');

function registerWebIpc(deps = {}) {
  const { handle, getSettings } = deps;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const audit = deps.audit && typeof deps.audit.append === 'function' ? deps.audit : null;
  const auditWrite = (row) => { if (audit) { try { audit.append(row); } catch { /* 审计坏了不影响业务 */ } } };

  function llmConfig() {
    try {
      const s = getSettings() || {};
      const llm = s.llm || {};
      return {
        provider: String(llm.provider || ''),
        baseUrl: String(llm.baseUrl || ''),
        model: String(llm.model || ''),
        apiKey: String(llm.apiKey || ''),
      };
    } catch {
      return { provider: '', baseUrl: '', model: '', apiKey: '' };
    }
  }

  handle('web:fetch', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const url = String(p.url || '').trim();
    if (!url) throw new Error('缺少要抓取的 URL');
    const lookup = (host) => new Promise((resolve, reject) => {
      dns.lookup(host, { all: true }, (err, list) => {
        if (err) reject(err);
        else resolve((list || []).map((x) => x.address));
      });
    });
    const res = await webFetch.fetchUrl({
      url,
      timeoutMs: p.timeoutMs,
      maxBytes: p.maxBytes,
      lookup,
    });
    auditWrite({
      channel: 'web:fetch', capability: 'web.fetch', risk: 'LOW', decision: 'allow',
      reason: 'public-read', summary: 'GET ' + res.finalUrl, ok: true,
    });
    log('web:fetch', res.finalUrl, res.status, res.bytes + 'B');
    return res;
  });

  handle('web:capabilities', async () => {
    const c = llmConfig();
    return webCaps.capabilitiesFor({ provider: c.provider, baseUrl: c.baseUrl, model: c.model });
  });

  handle('web:probe', async () => {
    const c = llmConfig();
    if (!c.apiKey) throw new Error('还没有配置对话模型的 API Key，无法探测联网能力');
    const res = await webCaps.probeProvider({
      provider: c.provider,
      baseUrl: c.baseUrl,
      model: c.model,
      apiKey: c.apiKey,
    });
    auditWrite({
      channel: 'web:probe', capability: 'web.fetch', risk: 'LOW', decision: 'allow',
      reason: 'capability-probe', summary: c.provider + ' ' + c.model + ' → ' + JSON.stringify(res.capabilities), ok: true,
    });
    log('web:probe', c.provider, c.model, '->', JSON.stringify(res.capabilities));
    return res;
  });
}

module.exports = { registerWebIpc };

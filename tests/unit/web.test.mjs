// ============================================================
// R6 单测：网页抓取（SSRF/体积/超时/正文抽取）+ 原生联网能力探针
//
// 全部用注入的 fetchImpl / lookup，不碰真实网络（CI 没有外网也不该红）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wf = require('../../shared/web-fetch.cjs');
const caps = require('../../shared/web-capabilities.cjs');

function res(body, { status = 200, headers = {}, ok = true } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: (k) => headers[String(k).toLowerCase()] || null },
    text: async () => body,
    body: null,
  };
}

const html = '<html><head><title>标题 &amp; 你好</title></head><body><script>alert(1)</script><p>第一段</p><p>第二段</p></body></html>';

describe('SSRF 防护', () => {
  it('拒绝内网/回环/链路本地/保留地址', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.2', '172.16.3.4', '169.254.1.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1']) {
      expect(wf.isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(wf.isPrivateAddress(ip)).toBe(false);
    }
  });

  it('DNS 解析到私网就拒绝（域名也会被绕）', async () => {
    await expect(wf.fetchUrl({
      url: 'https://evil.example.com/',
      lookup: async () => ['127.0.0.1'],
      fetchImpl: async () => res('x'),
    })).rejects.toThrow(/内网地址/);
  });

  it('只允许 http/https 与 80/443', async () => {
    await expect(wf.fetchUrl({ url: 'file:///etc/passwd', fetchImpl: async () => res('') })).rejects.toThrow(/http/);
    await expect(wf.fetchUrl({ url: 'http://example.com:8080/', fetchImpl: async () => res('') })).rejects.toThrow(/80\/443/);
  });

  it('不允许 URL 里带用户名/密码', async () => {
    await expect(wf.fetchUrl({ url: 'https://a:b@example.com/', fetchImpl: async () => res('') })).rejects.toThrow(/用户名/);
  });
});

describe('抓取与抽取', () => {
  it('抽标题、剥脚本、压空白', async () => {
    const r = await wf.fetchUrl({
      url: 'https://example.com/a',
      lookup: async () => ['93.184.216.34'],
      fetchImpl: async () => res(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    });
    expect(r.title).toBe('标题 & 你好');
    expect(r.text).toContain('第一段');
    expect(r.text).toContain('第二段');
    expect(r.text).not.toContain('alert(1)');
    expect(r.status).toBe(200);
    expect(r.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('重定向会被跟随，但每一跳都重新做 DNS 检查', async () => {
    let n = 0;
    const r = await wf.fetchUrl({
      url: 'https://example.com/',
      lookup: async () => ['93.184.216.34'],
      fetchImpl: async () => {
        n += 1;
        if (n === 1) return res('', { status: 302, headers: { location: 'http://internal.local/x' } });
        return res('ok', { headers: { 'content-type': 'text/plain' } });
      },
    });
    expect(r.text).toBe('ok');
    expect(n).toBe(2);
    await expect(wf.fetchUrl({
      url: 'https://example.com/',
      lookup: async (host) => (host === 'internal.local' ? ['10.0.0.1'] : ['93.184.216.34']),
      fetchImpl: async () => res('', { status: 302, headers: { location: 'http://internal.local/x' } }),
    })).rejects.toThrow(/内网地址/);
  });

  it('非 2xx 直接报错（不把错误页当正文）', async () => {
    await expect(wf.fetchUrl({
      url: 'https://example.com/404',
      lookup: async () => ['93.184.216.34'],
      fetchImpl: async () => res('not found', { status: 404 }),
    })).rejects.toThrow(/HTTP 404/);
  });

  it('体积上限会截断并标记 truncated', async () => {
    const big = '<p>' + 'x'.repeat(5000) + '</p>';
    const r = await wf.fetchUrl({
      url: 'https://example.com/big',
      lookup: async () => ['93.184.216.34'],
      maxBytes: 1024,
      fetchImpl: async () => res(big, { headers: { 'content-type': 'text/html' } }),
    });
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBeLessThanOrEqual(1100);
  });
});

describe('原生联网能力', () => {
  it('未探测时是 unknown，并带上官方文档链接', () => {
    const c = caps.capabilitiesFor({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-x' });
    expect(c.capabilities.nativeWebSearch).toBe('unknown');
    expect(c.evidence.sourceUrl).toContain('openai.com');
  });

  it('本地 ollama 直接 unsupported（没有服务端联网）', () => {
    const c = caps.capabilitiesFor({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen' });
    expect(c.capabilities.nativeWebSearch).toBe('unsupported');
  });

  it('200 且带服务端工具事件 → supported', async () => {
    const out = await caps.probeProvider({
      provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-x', apiKey: 'k',
      fetchImpl: async () => res(JSON.stringify({ output: [{ type: 'web_search_call' }], annotations: [{ url: 'https://a' }] })),
    });
    expect(out.capabilities.nativeWebSearch).toBe('supported');
    expect(out.evidence.reason).toBe('probe-ok');
  });

  it('200 但没有联网事件 → unsupported（端点接受了工具但没执行）', async () => {
    const out = await caps.probeProvider({
      provider: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm', apiKey: 'k',
      fetchImpl: async () => res(JSON.stringify({ choices: [{ message: { content: 'pong' } }] })),
    });
    expect(out.capabilities.nativeWebSearch).toBe('unsupported');
  });

  it('400 unknown tool → unsupported', async () => {
    const out = await caps.probeProvider({
      provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'k',
      fetchImpl: async () => res(JSON.stringify({ error: { message: 'unknown tool: web_search' } }), { status: 400 }),
    });
    expect(out.capabilities.nativeWebSearch).toBe('unsupported');
  });

  it('401 不能当成「不支持」（Key 错了 ≠ 没能力）', async () => {
    const out = await caps.probeProvider({
      provider: 'moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot', apiKey: 'bad',
      fetchImpl: async () => res('unauthorized', { status: 401 }),
    });
    expect(out.capabilities.nativeWebSearch).toBe('unknown');
    expect(out.evidence.reason).toBe('auth-failed');
  });

  it('网络错误 → unknown（不猜）', async () => {
    const out = await caps.probeProvider({
      provider: 'custom', baseUrl: 'https://example.invalid/v1', model: 'm', apiKey: 'k',
      fetchImpl: async () => { throw new Error('ENOTFOUND'); },
    });
    expect(out.capabilities.nativeWebSearch).toBe('unknown');
  });

  it('探测结果会进缓存，再读就走缓存', async () => {
    caps.clearCache();
    const params = { provider: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', apiKey: 'k' };
    await caps.probeProvider(Object.assign({}, params, {
      fetchImpl: async () => res(JSON.stringify({ grounding_metadata: { x: 1 } })),
    }));
    const cached = caps.capabilitiesFor(params);
    expect(cached.capabilities.nativeWebSearch).toBe('supported');
    expect(cached.evidence.checkedAt).toBeTruthy();
    caps.clearCache();
  });
});

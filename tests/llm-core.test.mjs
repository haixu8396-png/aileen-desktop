import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { createRequire } from 'node:module';

// SSE 解析现在在主进程（shared/llm.cjs），渲染层的 src/lib/llm.js 只是 IPC 代理。
// 单测直接打共享核心 —— 那才是真正发请求、真正解析流的一段代码。
const require = createRequire(import.meta.url);
const { streamChatCore } = require('../shared/llm.cjs');

const servers = [];
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port));
  });
}
afterEach(() => { while (servers.length) { try { servers.pop().close(); } catch { /* ignore */ } } });

const args = (baseUrl, extra) => Object.assign({
  baseUrl, apiKey: 'test-key', model: 'mock', temperature: 0.8, maxTokens: 100,
  messages: [{ role: 'user', content: 'hi' }],
}, extra || {});
const sse = (chunks) => chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n';
const sseServer = async (chunks) => startServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(sse(chunks));
  res.end();
});

describe('streamChatCore · SSE 解析', () => {
  it('按 data: 行增量解析并忽略非内容 delta', async () => {
    const body = ['data: {"choices":[{"delta":{"content":"你好"}}]}', '', 'data: {"choices":[{"delta":{"role":"assistant"}}]}', '', 'data: [DONE]', ''].join('\n');
    const url = await startServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(body); res.end(); });
    let acc = '';
    await streamChatCore(args(url, { onDelta: (d) => { acc += d; } }));
    expect(acc).toBe('你好');
  });

  it('跨 chunk 切断的行也能拼回', async () => {
    const url = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"AB');
      setTimeout(() => { res.write('C"}}]}\n\ndata: [DONE]\n\n'); res.end(); }, 10);
    });
    let acc = '';
    await streamChatCore(args(url, { onDelta: (d) => { acc += d; } }));
    expect(acc).toBe('ABC');
  });

  it('HTTP 错误 → HTTP_ERROR + status', async () => {
    const url = await startServer((req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"bad key"}}'); });
    await expect(streamChatCore(args(url, { onDelta: () => {} }))).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 401 });
  });

  it('没配 Key → NO_KEY，且不发请求', async () => {
    await expect(streamChatCore(args('https://x', { apiKey: '', onDelta: () => {} }))).rejects.toMatchObject({ code: 'NO_KEY' });
  });

  it('取消 → ABORTED', async () => {
    const url = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"A"}}]}\n\n');
    });
    const ctrl = new AbortController();
    const p = streamChatCore(args(url, { signal: ctrl.signal, onDelta: () => {} }));
    setTimeout(() => ctrl.abort(), 20);
    expect((await p.catch((e) => e)).code).toBe('ABORTED');
  });
});

describe('streamChatCore · 推理模型', () => {
  it('思考增量走 onReasoning，不污染正文', async () => {
    const url = await sseServer([
      { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '让我想想' }, finish_reason: null }] },
      { choices: [{ delta: { content: '答案是' }, finish_reason: null }] },
      { choices: [{ delta: { content: '42' }, finish_reason: 'stop' }] },
    ]);
    let acc = ''; let think = '';
    await streamChatCore(args(url, { onDelta: (d) => { acc += d; }, onReasoning: (r) => { think += r; } }));
    expect(acc).toBe('答案是42');
    expect(think).toBe('让我想想');
  });

  it('思考吃光预算、没有正文 → EMPTY_REPLY 且带上原因', async () => {
    const url = await sseServer([
      { choices: [{ delta: { reasoning_content: '想啊想' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
    ]);
    let acc = '';
    const err = await streamChatCore(args(url, { maxTokens: 300, onDelta: (d) => { acc += d; } })).catch((e) => e);
    expect(err.code).toBe('EMPTY_REPLY');
    expect(err.finishReason).toBe('length');
    expect(err.reasoningChars).toBeGreaterThan(0);
    expect(err.budget).toBe(300);
    expect(acc).toBe('');
  });

  it('有正文但被截断 → 照常返回', async () => {
    const url = await sseServer([
      { choices: [{ delta: { content: '说到一半' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
    ]);
    let acc = '';
    const info = await streamChatCore(args(url, { onDelta: (d) => { acc += d; } }));
    expect(acc).toBe('说到一半');
    expect(info.finishReason).toBe('length');
  });

  it('流里带 error 且无内容 → 带出模型给的原因', async () => {
    const url = await sseServer([{ error: { message: 'quota exceeded' } }]);
    const err = await streamChatCore(args(url, { onDelta: () => {} })).catch((e) => e);
    expect(err.code).toBe('EMPTY_REPLY');
    expect(err.streamError).toBe('quota exceeded');
  });

  it('完全空响应 → EMPTY_REPLY，绝不安静返回空串', async () => {
    const url = await sseServer([{ choices: [{ delta: { role: 'assistant' }, finish_reason: 'stop' }] }]);
    await expect(streamChatCore(args(url, { onDelta: () => {} }))).rejects.toMatchObject({ code: 'EMPTY_REPLY' });
  });
});

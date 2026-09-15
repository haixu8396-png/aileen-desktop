import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { streamChat } from '../src/lib/llm.js';

const servers = [];
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port));
  });
}

afterEach(() => {
  while (servers.length) { try { servers.pop().close(); } catch { /* ignore */ } }
});

const baseSettings = (baseUrl) => ({ llm: { baseUrl, apiKey: 'test-key', model: 'mock', temperature: 0.8, maxTokens: 100 } });

describe('streamChat SSE 解析', () => {
  it('按 data: 行增量解析并忽略非内容 delta', async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"你好"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"，世界"}}]}',
      '',
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const url = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(body);
      res.end();
    });
    let acc = '';
    await streamChat({ messages: [{ role: 'user', content: 'hi' }], settings: baseSettings(url), onDelta: (d) => { acc += d; } });
    expect(acc).toBe('你好，世界');
  });

  it('跨 chunk 切断的行也能正确拼回', async () => {
    const url = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"AB');
      setTimeout(() => { res.write('C"}}]}\n\ndata: [DONE]\n\n'); res.end(); }, 10);
    });
    let acc = '';
    await streamChat({ messages: [{ role: 'user', content: 'hi' }], settings: baseSettings(url), onDelta: (d) => { acc += d; } });
    expect(acc).toBe('ABC');
  });

  it('HTTP 错误抛出带状态码的异常', async () => {
    const url = await startServer((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"bad key"}}');
    });
    await expect(streamChat({ messages: [], settings: baseSettings(url), onDelta: () => {} })).rejects.toThrow(/401/);
  });

  it('未配置 API Key 时直接报错', async () => {
    await expect(streamChat({ messages: [], settings: { llm: { baseUrl: 'https://x', apiKey: '', model: 'm' } }, onDelta: () => {} })).rejects.toThrow(/API Key/);
  });
});

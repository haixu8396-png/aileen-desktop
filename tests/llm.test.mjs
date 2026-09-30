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
describe('streamChat 推理模型（reasoning_content）', () => {
  const sse = (chunks) => chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n';

  it('思考增量走 onReasoning，不污染正文', async () => {
    const url = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse([
        { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '让我想想' }, finish_reason: null }] },
        { choices: [{ delta: { content: null, reasoning_content: '…' }, finish_reason: null }] },
        { choices: [{ delta: { content: '答案是' }, finish_reason: null }] },
        { choices: [{ delta: { content: '42' }, finish_reason: 'stop' }] },
      ]));
      res.end();
    });
    let acc = '';
    let think = '';
    await streamChat({
      messages: [{ role: 'user', content: 'hi' }],
      settings: baseSettings(url),
      onDelta: (d) => { acc += d; },
      onReasoning: (r) => { think += r; },
    });
    expect(acc).toBe('答案是42');
    expect(think).toBe('让我想想…');
    expect(acc).not.toContain('让我想想');
  });

  it('思考吃光预算、一个字正文都没有 → 抛错说清楚，绝不返回空气泡', async () => {
    const url = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse([
        { choices: [{ delta: { reasoning_content: '想啊想啊想' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'length' }] },
      ]));
      res.end();
    });
    let acc = '';
    const p = streamChat({ messages: [], settings: baseSettings(url), onDelta: (d) => { acc += d; } });
    await expect(p).rejects.toThrow(/{n}|max|token|上限/i);
    await p.catch((e) => {
      expect(e.code).toBe('EMPTY_REPLY');
      expect(e.finishReason).toBe('length');
      expect(e.reasoningChars).toBeGreaterThan(0);
    });
    expect(acc).toBe('');
  });

  it('模型返回了内容但被上限截断 → 照常返回（有内容就不算失败）', async () => {
    const url = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse([
        { choices: [{ delta: { content: '说到一半' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'length' }] },
      ]));
      res.end();
    });
    let acc = '';
    await streamChat({ messages: [], settings: baseSettings(url), onDelta: (d) => { acc += d; } });
    expect(acc).toBe('说到一半');
  });

  it('流里带 error 且没有任何内容 → 抛出模型给的错误原因', async () => {
    const url = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse([{ error: { message: 'quota exceeded' } }]));
      res.end();
    });
    await expect(streamChat({ messages: [], settings: baseSettings(url), onDelta: () => {} }))
      .rejects.toThrow(/quota exceeded/);
  });

  it('完全空响应 → 明确的「什么都没返回」而不是空气泡', async () => {
    const url = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse([{ choices: [{ delta: { role: 'assistant' }, finish_reason: 'stop' }] }]));
      res.end();
    });
    await expect(streamChat({ messages: [], settings: baseSettings(url), onDelta: () => {} }))
      .rejects.toThrow(/nothing|空|返回/i);
  });
});

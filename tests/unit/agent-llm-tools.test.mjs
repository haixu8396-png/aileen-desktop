import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { createRequire } from 'node:module';

// Agent 依赖「带工具的流式对话」：模型可能只调工具、一个字正文都不写，
// 而工具调用是**按 index 分片**下发的（name 和 arguments 都会被切开）。
// 这几条是 Agent 能不能跑起来的地基，所以单独锁住。
const require = createRequire(import.meta.url);
const { streamChatCore, accumulateToolCalls, compactToolCalls } = require('../../shared/llm.cjs');

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

/** 抓取请求体，并按脚本回 SSE */
async function toolServer(chunks, onBody) {
  return startServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { if (onBody) onBody(JSON.parse(raw)); } catch { /* ignore */ }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const c of chunks) res.write('data: ' + JSON.stringify(c) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
}

const TOOLS = [{
  type: 'function',
  function: { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
}];

describe('工具调用的流式累积', () => {
  it('accumulateToolCalls 按 index 分片拼回同一个调用', () => {
    const acc = [];
    accumulateToolCalls(acc, [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }]);
    accumulateToolCalls(acc, [{ index: 0, function: { arguments: 'th":"a.js"}' } }]);
    expect(acc[0].id).toBe('call_1');
    expect(acc[0].function.name).toBe('read_file');
    expect(acc[0].function.arguments).toBe('{"path":"a.js"}');
  });

  it('多个工具调用各自成槽', () => {
    const acc = [];
    accumulateToolCalls(acc, [{ index: 0, id: 'a', function: { name: 'read_file', arguments: '{}' } }]);
    accumulateToolCalls(acc, [{ index: 1, id: 'b', function: { name: 'git_status', arguments: '{}' } }]);
    expect(compactToolCalls(acc).map((c) => c.function.name)).toEqual(['read_file', 'git_status']);
  });

  it('空槽被丢掉（模型偶尔会跳 index）', () => {
    const acc = [];
    accumulateToolCalls(acc, [{ index: 2, id: 'c', function: { name: 'x', arguments: '{}' } }]);
    expect(compactToolCalls(acc)).toHaveLength(1);
  });
});

describe('streamChatCore · 带工具', () => {
  it('请求体里带上 tools 与 tool_choice', async () => {
    let seen = null;
    const url = await toolServer(
      [{ choices: [{ delta: { content: '好的' }, finish_reason: 'stop' }] }],
      (body) => { seen = body; },
    );
    await streamChatCore(args(url, { tools: TOOLS }));
    expect(Array.isArray(seen.tools)).toBe(true);
    expect(seen.tools[0].function.name).toBe('read_file');
    expect(seen.tool_choice).toBe('auto');
  });

  it('不带工具时请求体里没有 tools（普通对话不该被它分心）', async () => {
    let seen = null;
    const url = await toolServer(
      [{ choices: [{ delta: { content: '好的' }, finish_reason: 'stop' }] }],
      (body) => { seen = body; },
    );
    await streamChatCore(args(url, {}));
    expect(seen.tools).toBeUndefined();
    expect(seen.tool_choice).toBeUndefined();
  });

  it('跨 chunk 切断的工具增量能拼回，并从返回值拿到 toolCalls', async () => {
    const url = await toolServer([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'read_', arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a.js"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const info = await streamChatCore(args(url, { tools: TOOLS }));
    expect(info.toolCalls).toHaveLength(1);
    expect(info.toolCalls[0].function.name).toBe('read_file');
    expect(JSON.parse(info.toolCalls[0].function.arguments)).toEqual({ path: 'a.js' });
    expect(info.finishReason).toBe('tool_calls');
  });

  it('只调工具、正文为空：不算空回复（这是 Agent 的正常一轮）', async () => {
    const url = await toolServer([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'git_status', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const info = await streamChatCore(args(url, { tools: TOOLS }));
    expect(info.contentChars).toBe(0);
    expect(info.toolCalls).toHaveLength(1);
  });

  it('正文和工具都没有 → 仍然是 EMPTY_REPLY（不能让 Agent 空转）', async () => {
    const url = await toolServer([{ choices: [{ delta: {}, finish_reason: 'length' }] }]);
    await expect(streamChatCore(args(url, { tools: TOOLS }))).rejects.toMatchObject({ code: 'EMPTY_REPLY' });
  });

  it('推理模型的思考增量与工具调用可以同时出现', async () => {
    const chunks = [];
    const url = await toolServer([
      { choices: [{ delta: { reasoning_content: '我先看看' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'list_files', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const info = await streamChatCore(args(url, { tools: TOOLS, onReasoning: (t) => chunks.push(t) }));
    expect(chunks.join('')).toBe('我先看看');
    expect(info.reasoningChars).toBe('我先看看'.length);
    expect(info.toolCalls[0].function.name).toBe('list_files');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { streamChat } from '../../src/lib/llm.js';
import { setLang } from '../../src/lib/i18n.js';

// 渲染层这一侧现在只是 IPC 代理：这里专门验证两件事 ——
//   1) 它**绝不会**把 API Key 送出去（Key 只存在于主进程）；
//   2) 主进程回的错误码能被翻译成当前语言的文案，并保留 AbortError 语义。
function makeFakeApi(opts) {
  const listeners = [];
  const sent = [];
  const aborted = [];
  globalThis.window = {
    api: {
      SECRET_CLEAR: '__AILEEN_CLEAR_SECRET__',
      onLlmChunk: (cb) => {
        listeners.push(cb);
        return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
      },
      llmStream: async (payload) => {
        sent.push(payload);
        if (opts && opts.failStream) throw new Error('ipc failed');
        return { accepted: true };
      },
      llmAbort: async (id) => { aborted.push(id); return true; },
    },
  };
  return {
    push: (msg) => listeners.slice().forEach((cb) => cb(msg)),
    sent,
    aborted,
    listenerCount: () => listeners.length,
  };
}

const settings = (over) => ({ llm: Object.assign({ baseUrl: 'https://api.test', model: 'm', temperature: 0.5, maxTokens: 321 }, over || {}) });

describe('streamChat（渲染层代理）', () => {
  beforeEach(() => setLang('zh'));

  it('绝不把 API Key 送出去，只送非敏感参数', async () => {
    const api = makeFakeApi();
    const p = streamChat({
      messages: [{ role: 'user', content: 'hi' }],
      // 故意塞一个 Key：这是旧调用方会做的事，代理层必须把它丢掉
      settings: settings({ apiKey: 'sk-should-never-leave-renderer' }),
      onDelta: () => {},
    });
    await Promise.resolve();
    expect(api.sent).toHaveLength(1);
    const payload = api.sent[0];
    expect(JSON.stringify(payload)).not.toContain('sk-should-never-leave-renderer');
    expect(payload.llm.apiKey).toBeUndefined();
    expect(payload.llm.model).toBe('m');
    expect(payload.llm.maxTokens).toBe(321);
    expect(typeof payload.requestId).toBe('string');
    api.push({ requestId: payload.requestId, type: 'finish' });
    await p;
  });

  it('增量与收尾按顺序派发，收尾后不再重复触发', async () => {
    const api = makeFakeApi();
    const deltas = [];
    const thinks = [];
    const finishes = [];
    const p = streamChat({
      messages: [], settings: settings(),
      onDelta: (d) => deltas.push(d),
      onReasoning: (r) => thinks.push(r),
      onFinish: (i) => finishes.push(i),
    });
    await Promise.resolve();
    const id = api.sent[0].requestId;
    api.push({ requestId: id, type: 'reasoning', text: '想' });
    api.push({ requestId: id, type: 'delta', text: '你好' });
    api.push({ requestId: id, type: 'finish', finishReason: 'stop', contentChars: 2 });
    api.push({ requestId: id, type: 'delta', text: '迟到的增量' });
    api.push({ requestId: id, type: 'finish' });
    await p;
    expect(thinks).toEqual(['想']);
    expect(deltas).toEqual(['你好']);
    expect(finishes).toHaveLength(1);
    expect(finishes[0].finishReason).toBe('stop');
  });

  it('别的请求的增量不会串进来', async () => {
    const api = makeFakeApi();
    const deltas = [];
    const p = streamChat({ messages: [], settings: settings(), onDelta: (d) => deltas.push(d) });
    await Promise.resolve();
    const id = api.sent[0].requestId;
    api.push({ requestId: 'someone-else', type: 'delta', text: '别人的' });
    api.push({ requestId: id, type: 'delta', text: '我的' });
    api.push({ requestId: id, type: 'finish' });
    await p;
    expect(deltas).toEqual(['我的']);
  });

  it('EMPTY_REPLY 会翻成本地化文案，并带上 code', async () => {
    const api = makeFakeApi();
    const p = streamChat({ messages: [], settings: settings(), onDelta: () => {} });
    await Promise.resolve();
    const id = api.sent[0].requestId;
    api.push({ requestId: id, type: 'error', code: 'EMPTY_REPLY', reasoningChars: 10, budget: 4096, finishReason: 'length' });
    const err = await p.catch((e) => e);
    expect(err.code).toBe('EMPTY_REPLY');
    expect(err.message).toContain('4096');
    expect(err.message).not.toBe('EMPTY_REPLY');
  });

  it('ABORTED 变回 AbortError（上层靠 name 判断，不该弹 toast）', async () => {
    const api = makeFakeApi();
    const p = streamChat({ messages: [], settings: settings(), onDelta: () => {} });
    await Promise.resolve();
    const id = api.sent[0].requestId;
    api.push({ requestId: id, type: 'error', code: 'ABORTED' });
    const err = await p.catch((e) => e);
    expect(err.name).toBe('AbortError');
  });

  it('取消时通知主进程中止，并且不会留下监听器', async () => {
    const api = makeFakeApi();
    const ctrl = new AbortController();
    const p = streamChat({ messages: [], settings: settings(), signal: ctrl.signal, onDelta: () => {} });
    await Promise.resolve();
    const id = api.sent[0].requestId;
    ctrl.abort();
    expect(api.aborted).toEqual([id]);
    api.push({ requestId: id, type: 'error', code: 'ABORTED' });
    await p.catch(() => {});
    expect(api.listenerCount()).toBe(0);
  });

  it('已经处于取消状态的 signal：不发请求，直接按 AbortError 抛', async () => {
    const api = makeFakeApi();
    const ctrl = new AbortController();
    ctrl.abort();
    const err = await streamChat({ messages: [], settings: settings(), signal: ctrl.signal, onDelta: () => {} }).catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(api.sent).toHaveLength(0);
    expect(api.listenerCount()).toBe(0);
  });
});

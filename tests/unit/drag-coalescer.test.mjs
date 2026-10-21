import { describe, it, expect } from 'vitest';
import { createDragCoalescer } from '../../src/lib/drag-coalescer.js';

/** 手动的 rAF 替身：什么时候跑由测试决定 */
function makeClock() {
  let next = 1;
  const pending = new Map();
  return {
    schedule(fn) { const h = next; next += 1; pending.set(h, fn); return h; },
    cancel(h) { pending.delete(h); },
    /** 跑掉一帧（所有排队回调） */
    tick() {
      const run = [...pending.values()];
      pending.clear();
      run.forEach((fn) => fn());
    },
    get size() { return pending.size; },
  };
}

describe('drag-coalescer：拖动 IPC 的合并器', () => {
  it('同一帧内的多次请求只发一次调用', async () => {
    const clock = makeClock();
    const calls = [];
    const c = createDragCoalescer({ call: () => calls.push(Date.now()), schedule: clock.schedule, cancel: clock.cancel });
    c.start();
    for (let i = 0; i < 20; i += 1) c.request();
    expect(calls.length).toBe(0);      // 还没到帧
    clock.tick();
    expect(calls.length).toBe(1);
    expect(c.stats().dropped).toBe(19);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.length).toBe(1);      // 没有在途请求要重发
  });

  it('在途期间只保留「还要再发一次」，不会排队', async () => {
    const clock = makeClock();
    let resolveFirst;
    const calls = [];
    const c = createDragCoalescer({
      call: () => {
        calls.push(calls.length);
        return new Promise((r) => { if (calls.length === 1) resolveFirst = r; else r(); });
      },
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    c.start();
    c.request();
    clock.tick();
    expect(calls.length).toBe(1);
    // 第一个调用还没回来，这期间来了 50 个事件 —— 只能留下一个「稍后再发」
    for (let i = 0; i < 50; i += 1) {
      c.request();
      clock.tick();
    }
    expect(calls.length).toBe(1);
    expect(c.stats().queued).toBe(true);
    resolveFirst();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(2);      // 立刻补发最新的一次
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(2);      // 补齐之后不再多发
  });

  it('end() 之后不再发调用，待发帧被取消', async () => {
    const clock = makeClock();
    let n = 0;
    const c = createDragCoalescer({ call: () => { n += 1; }, schedule: clock.schedule, cancel: clock.cancel });
    c.start();
    c.request();
    expect(clock.size).toBe(1);
    c.end();
    expect(clock.size).toBe(0);        // 帧被取消
    clock.tick();
    await Promise.resolve();
    expect(n).toBe(0);
    expect(c.stats().pending).toBe(false);
  });

  it('end() 之后到来的事件被忽略（松开鼠标不会继续移动窗口）', async () => {
    const clock = makeClock();
    let n = 0;
    const c = createDragCoalescer({ call: () => { n += 1; }, schedule: clock.schedule, cancel: clock.cancel });
    c.start();
    c.end();
    for (let i = 0; i < 10; i += 1) c.request();
    clock.tick();
    await Promise.resolve();
    expect(n).toBe(0);
  });

  it('在途调用失败不会卡死（下一个事件照样能发）', async () => {
    const clock = makeClock();
    let n = 0;
    const c = createDragCoalescer({
      call: () => {
        n += 1;
        if (n === 1) return Promise.reject(new Error('窗口没了'));
        return Promise.resolve();
      },
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    c.start();
    c.request();
    clock.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(c.stats().inFlight).toBe(false);
    c.request();
    clock.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(n).toBe(2);
  });

  it('call 同步抛错也不会让合并器停在「在途」状态', async () => {
    const clock = makeClock();
    let n = 0;
    const c = createDragCoalescer({
      call: () => { n += 1; if (n === 1) throw new Error('同步炸了'); },
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    c.start();
    c.request();
    clock.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(c.stats().inFlight).toBe(false);
    c.request();
    clock.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(n).toBe(2);
  });

  it('没 start 之前的请求不会发调用', () => {
    const clock = makeClock();
    let n = 0;
    const c = createDragCoalescer({ call: () => { n += 1; }, schedule: clock.schedule, cancel: clock.cancel });
    c.request();
    clock.tick();
    expect(n).toBe(0);
  });
});

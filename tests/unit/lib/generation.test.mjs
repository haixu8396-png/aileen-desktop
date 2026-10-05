import { describe, it, expect, vi } from 'vitest';
import { createGeneration } from '../../../src/lib/generation.js';

// ---------------------------------------------------------------------------
// 代际令牌：让「过期的异步回调」失效。
// 这组测试对应真实踩过的三类竞态：
//   1) 已停止，但上一次的回调回来又把循环拉起来（stale callback）；
//   2) 停止后定时器还到期，凭空多跑一轮；
//   3) 连点两次「开始」，起了两个循环。
// ---------------------------------------------------------------------------

/** 可控时钟：手动推进，避免测试真的等 */
function fakeClock() {
  let now = 0;
  const jobs = [];
  return {
    setTimeoutFn: (fn, ms) => {
      const job = { fn, at: now + ms, id: jobs.length, cleared: false };
      jobs.push(job);
      return job;
    },
    clearTimeoutFn: (job) => { if (job && typeof job === 'object') job.cleared = true; },
    tick(ms) {
      now += ms;
      for (const job of jobs) {
        if (!job.cleared && !job.fired && job.at <= now) {
          job.fired = true;
          job.fn();
        }
      }
    },
    pending: () => jobs.filter((j) => !j.cleared && !j.fired).length,
    total: () => jobs.length,
  };
}

describe('代际令牌', () => {
  it('begin 后 isCurrent 为真；未 begin 时为假', () => {
    const g = createGeneration();
    const before = g.current();
    expect(g.isCurrent(before)).toBe(false);
    const token = g.begin();
    expect(g.isCurrent(token)).toBe(true);
  });

  it('重复 begin 返回 null（用来拒绝「连点两次开始」）', () => {
    const g = createGeneration();
    expect(g.begin()).not.toBeNull();
    expect(g.begin()).toBeNull();
    expect(g.begin()).toBeNull();
  });

  it('end 之后旧 token 立刻失效（stale callback 的核心保障）', () => {
    const g = createGeneration();
    const token = g.begin();
    expect(g.isCurrent(token)).toBe(true);
    g.end();
    expect(g.isCurrent(token)).toBe(false);
  });

  it('end 之后再 begin，旧 token 仍然失效（号是单调的，不会复用）', () => {
    const g = createGeneration();
    const old = g.begin();
    g.end();
    const fresh = g.begin();
    expect(g.isCurrent(old)).toBe(false);
    expect(g.isCurrent(fresh)).toBe(true);
    expect(fresh).not.toBe(old);
  });

  it('schedule：仍在当前代时到点执行', () => {
    const g = createGeneration();
    const clock = fakeClock();
    const token = g.begin();
    const ran = [];
    g.schedule(() => ran.push('ok'), 100, clock.setTimeoutFn, clock.clearTimeoutFn);
    clock.tick(50);
    expect(ran).toHaveLength(0);
    clock.tick(60);
    expect(ran).toEqual(['ok']);
    expect(g.isCurrent(token)).toBe(true);
  });

  it('schedule：换代之后到点**不执行**（停止后不再凭空跑一轮）', () => {
    const g = createGeneration();
    const clock = fakeClock();
    g.begin();
    const ran = [];
    g.schedule(() => ran.push('should-not-run'), 100, clock.setTimeoutFn, clock.clearTimeoutFn);
    g.end(clock.clearTimeoutFn);       // 用户点了停止
    clock.tick(500);
    expect(ran).toHaveLength(0);
  });

  it('schedule：end 会把待执行的定时器真的 clear 掉', () => {
    const g = createGeneration();
    const clock = fakeClock();
    g.begin();
    g.schedule(() => {}, 100, clock.setTimeoutFn, clock.clearTimeoutFn);
    g.schedule(() => {}, 200, clock.setTimeoutFn, clock.clearTimeoutFn);
    expect(g.pendingCount()).toBe(2);
    const cleared = g.end(clock.clearTimeoutFn);
    expect(cleared).toBe(2);
    expect(g.pendingCount()).toBe(0);
  });

  it('end 之后重新 begin：上一代的定时器不会污染新代', () => {
    const g = createGeneration();
    const clock = fakeClock();
    const ran = [];
    g.begin();
    g.schedule(() => ran.push('old'), 100, clock.setTimeoutFn, clock.clearTimeoutFn);
    g.end(clock.clearTimeoutFn);
    const fresh = g.begin();
    g.schedule(() => ran.push('new'), 150, clock.setTimeoutFn, clock.clearTimeoutFn);
    clock.tick(1000);
    expect(ran).toEqual(['new']);
    expect(g.isCurrent(fresh)).toBe(true);
  });

  it('adopt：外部创建的定时器也被 end 清掉（等 TTS 空闲那种场景）', () => {
    const g = createGeneration();
    const clock = fakeClock();
    g.begin();
    const iv = { id: 'interval' };
    const guard = { id: 'guard' };
    g.adopt(iv, clock.clearTimeoutFn);
    g.adopt(guard, clock.clearTimeoutFn);
    expect(g.pendingCount()).toBe(2);
    const cleared = g.end(clock.clearTimeoutFn);
    expect(cleared).toBe(2);
    expect(iv.cleared).toBe(true);
    expect(guard.cleared).toBe(true);
  });

  it('schedule 用真实定时器也能跑（防 mock 掩盖问题）', async () => {
    const g = createGeneration();
    g.begin();
    const ran = [];
    g.schedule(() => ran.push('real'), 10, setTimeout, clearTimeout);
    await new Promise((r) => setTimeout(r, 40));
    expect(ran).toEqual(['real']);
  });

  it('真实定时器 + 立即 end：回调不该跑', async () => {
    const g = createGeneration();
    g.begin();
    const ran = [];
    g.schedule(() => ran.push('nope'), 20, setTimeout, clearTimeout);
    g.end(clearTimeout);
    await new Promise((r) => setTimeout(r, 60));
    expect(ran).toHaveLength(0);
  });
});

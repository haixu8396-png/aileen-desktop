// ============================================================
// 授权中心（shared/authz.cjs）单测
//
// 这一份是「主进程最终判定」的策略来源，测的是判定矩阵本身：
// 模式 × 风险 × 撤销/过期 × 凭证一次性 × 参数绑定。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const authz = require('../../shared/authz.cjs');

const {
  CAPABILITY, RISK, normalizeCfg, decide, argsHash, projection, createGrants, summarize,
  isActionCapability, riskOf,
} = authz;

const MANUAL = { mode: 'manual' };
const TRUST = { mode: 'trust' };
const TRUST_HIGH = { mode: 'trust', allowHighRisk: true };
const FULL = { mode: 'trust', allowHighRisk: true, fullAccess: true };

const now = 1_800_000_000_000;

function d(capability, cfg, extra = {}) {
  return decide({ capability, cfg: normalizeCfg(cfg), now, ...extra });
}

describe('判定矩阵', () => {
  it('LOW 任何模式都放行', () => {
    for (const cfg of [MANUAL, TRUST, TRUST_HIGH, FULL]) {
      expect(d(CAPABILITY.FS_READ, cfg).decision).toBe('allow');
    }
  });

  it('MEDIUM：手动模式要批准；批量/信任模式放行；关掉 requireMedium 也放行', () => {
    expect(d(CAPABILITY.FS_WRITE, MANUAL).decision).toBe('ask');
    expect(d(CAPABILITY.FS_WRITE, MANUAL, { requireMedium: false }).decision).toBe('allow');
    expect(d(CAPABILITY.FS_WRITE, { mode: 'batch' }).decision).toBe('allow');
    expect(d(CAPABILITY.FS_WRITE, TRUST).decision).toBe('allow');
  });

  it('HIGH：只有「信任 + allowHighRisk」自动执行', () => {
    expect(d(CAPABILITY.INPUT_KEYBOARD, MANUAL).decision).toBe('ask');
    expect(d(CAPABILITY.INPUT_POINTER, { mode: 'batch' }).decision).toBe('ask');
    expect(d(CAPABILITY.EXEC, TRUST).decision).toBe('ask');
    expect(d(CAPABILITY.EXEC, TRUST_HIGH).decision).toBe('allow');
  });

  it('完整权限：HIGH 与 CRITICAL 都放行（敏感目标由主进程另一条路拒绝）', () => {
    expect(d(CAPABILITY.EXEC, FULL).decision).toBe('allow');
    expect(d(CAPABILITY.APP_LAUNCH, FULL).decision).toBe('allow');
    expect(d(CAPABILITY.INPUT_KEYBOARD, FULL).decision).toBe('allow');
  });

  it('CRITICAL 即使完整权限也只到 ask（这是刻意的）', () => {
    const r = decide({ capability: 'disk.format', risk: RISK.CRITICAL, cfg: normalizeCfg(FULL), now });
    expect(r.decision).toBe('ask');
    expect(r.reason).toBe('critical-risk');
  });

  it('撤销与过期优先于完整权限', () => {
    const revoked = { ...FULL, revokedAt: now - 1 };
    const expired = { ...FULL, expiresAt: now - 1 };
    expect(d(CAPABILITY.FS_WRITE, revoked)).toMatchObject({ decision: 'deny', reason: 'authorization-revoked' });
    expect(d(CAPABILITY.FS_WRITE, expired)).toMatchObject({ decision: 'deny', reason: 'authorization-expired' });
  });

  it('未知能力按 HIGH 处理（宁可多问一句）', () => {
    expect(riskOf('something.new')).toBe(RISK.HIGH);
    expect(d('something.new', MANUAL).decision).toBe('ask');
  });

  it('只有动作类能力才需要凭证', () => {
    expect(isActionCapability(CAPABILITY.FS_WRITE)).toBe(true);
    expect(isActionCapability(CAPABILITY.EXEC)).toBe(true);
    expect(isActionCapability(CAPABILITY.FS_READ)).toBe(false);
    expect(isActionCapability(CAPABILITY.SCREEN_CAPTURE)).toBe(false);
  });
});

describe('参数投影与哈希', () => {
  it('同一个动作哈希稳定，改了目标就变', () => {
    const a = argsHash(CAPABILITY.FS_WRITE, { op: 'write', path: 'D:/x/a.txt', text: 'one' });
    const b = argsHash(CAPABILITY.FS_WRITE, { op: 'write', path: 'D:/x/a.txt', text: 'two' });
    const c = argsHash(CAPABILITY.FS_WRITE, { op: 'write', path: 'D:/x/b.txt' });
    expect(a).toBe(b);            // 正文不参与（只绑路径）
    expect(a).not.toBe(c);        // 换文件 = 换身份
  });

  it('执行命令的哈希包含程序与参数', () => {
    const base = argsHash(CAPABILITY.EXEC, { command: 'npm', args: ['test'] });
    expect(argsHash(CAPABILITY.EXEC, { command: 'npm', args: ['test'] })).toBe(base);
    expect(argsHash(CAPABILITY.EXEC, { command: 'npm', args: ['run', 'build'] })).not.toBe(base);
    expect(argsHash(CAPABILITY.EXEC, { command: 'rm', args: ['-rf', '/'] })).not.toBe(base);
  });

  it('投影只保留安全性相关的字段', () => {
    const p = projection(CAPABILITY.INPUT_KEYBOARD, { op: 'keyboardType', text: 'secret', extra: 'x' });
    expect(p).toEqual({ op: 'keyboardType', text: 'secret', keys: [] });
    const m = projection(CAPABILITY.INPUT_POINTER, { op: 'mouseClick', x: 1.6, y: 2.2, button: 'left', double: true });
    expect(m).toMatchObject({ op: 'mouseClick', x: 2, y: 2, button: 'left', double: true });
    // 滚动/拖拽靠 direction / amount / 终点坐标区分，不能混成同一个动作
    const scroll = projection(CAPABILITY.INPUT_POINTER, { op: 'scroll', direction: 'up', amount: 3, x: 10, y: 20 });
    expect(scroll).toMatchObject({ op: 'scroll', direction: 'up', amount: 3, x: 10, y: 20 });
  });
});

describe('一次性凭证', () => {
  it('记一次只能用一次', () => {
    const grants = createGrants({ now: () => now, ttlMs: 1000 });
    const hash = argsHash(CAPABILITY.FS_WRITE, { path: 'a.txt' });
    grants.issue({ capability: CAPABILITY.FS_WRITE, argsHash: hash });
    expect(grants.consume({ capability: CAPABILITY.FS_WRITE, argsHash: hash })).toBe(true);
    expect(grants.consume({ capability: CAPABILITY.FS_WRITE, argsHash: hash })).toBe(false);
  });

  it('能力或参数不同都不认', () => {
    const grants = createGrants({ now: () => now });
    grants.issue({
      capability: CAPABILITY.FS_WRITE,
      argsHash: argsHash(CAPABILITY.FS_WRITE, { path: 'a.txt' }),
    });
    expect(grants.consume({
      capability: CAPABILITY.FS_WRITE,
      argsHash: argsHash(CAPABILITY.FS_WRITE, { path: 'b.txt' }),
    })).toBe(false);
    expect(grants.consume({
      capability: CAPABILITY.EXEC,
      argsHash: argsHash(CAPABILITY.EXEC, { command: 'npm', args: [] }),
    })).toBe(false);
  });

  it('过期自动作废', () => {
    let t = now;
    const grants = createGrants({ now: () => t, ttlMs: 1000 });
    const hash = argsHash(CAPABILITY.EXEC, { command: 'npm', args: ['test'] });
    grants.issue({ capability: CAPABILITY.EXEC, argsHash: hash });
    t += 1001;
    expect(grants.consume({ capability: CAPABILITY.EXEC, argsHash: hash })).toBe(false);
  });

  it('数量上限：超出后丢最老的，不会无限涨', () => {
    const grants = createGrants({ now: () => now, max: 2, ttlMs: 60000 });
    for (let i = 0; i < 5; i += 1) {
      grants.issue({ capability: CAPABILITY.FS_WRITE, argsHash: 'h' + i });
    }
    expect(grants.size()).toBeLessThanOrEqual(2);
  });
});

describe('审计摘要', () => {
  it('写文件只记路径，不记正文', () => {
    const s = summarize(CAPABILITY.FS_WRITE, { op: 'write', path: 'a.txt', text: 'PASSWORD=123' });
    expect(s).toBe('write a.txt');
    expect(s).not.toContain('PASSWORD');
  });

  it('键盘输入只记长度，不记内容', () => {
    const s = summarize(CAPABILITY.INPUT_KEYBOARD, { op: 'keyboardType', text: 'hunter2' });
    expect(s).toContain('7 chars');
    expect(s).not.toContain('hunter2');
  });

  it('命令记程序与参数（这是要能被审计的）', () => {
    const s = summarize(CAPABILITY.EXEC, { command: 'git', args: ['status', '--short'] });
    expect(s).toBe('git status --short');
  });

  it('超长摘要会被截断', () => {
    const s = summarize(CAPABILITY.APP_LAUNCH, { target: 'x'.repeat(500) });
    expect(s.length).toBeLessThanOrEqual(201);
  });
});

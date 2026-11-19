// ============================================================
// Agent 审计日志（append-only JSONL）单测
//
// 三条要钉住的性质：
//   1) 只写白名单字段（多传的字段一个都不能落盘）
//   2) 按天分文件，tail 能读到最新几条
//   3) 写失败/超上限不抛错（审计坏了不能把 Agent 打死）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAuditLog, dayKey, sanitize } = require('../../src/main/storage/audit-log.cjs');

let dir;
const FIXED = new Date('2026-11-20T10:00:00.000Z');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aileen-audit-'));
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

function makeLog(opts = {}) {
  return createAuditLog(Object.assign({ dir, now: () => FIXED, log: () => {} }, opts));
}

describe('写入与读取', () => {
  it('写进去的是一条 JSON，字段齐全', () => {
    const log = makeLog();
    const r = log.append({
      channel: 'agent:fs', capability: 'fs.write', risk: 'MEDIUM',
      decision: 'grant', reason: 'medium-needs-approval', summary: 'write a.txt',
    });
    expect(r.ok).toBe(true);
    const file = path.join(dir, 'agent-audit-' + dayKey(FIXED) + '.jsonl');
    expect(fs.existsSync(file)).toBe(true);
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: 'agent:fs', capability: 'fs.write', risk: 'MEDIUM',
      decision: 'grant', summary: 'write a.txt',
    });
    expect(rows[0].ts).toContain('2026-11-20');
  });

  it('多传的字段不会落盘（只留白名单）', () => {
    const log = makeLog();
    log.append({ channel: 'x', capability: 'y', decision: 'allow', apiKey: 'sk-secret', text: 'PASSWORD' });
    const rows = log.tail(5);
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('apiKey');
    expect(rows[0]).not.toHaveProperty('text');
    expect(JSON.stringify(rows[0])).not.toContain('sk-secret');
  });

  it('tail 从新到旧读最近 n 条', () => {
    const log = makeLog();
    for (let i = 0; i < 5; i += 1) log.append({ channel: 'c', capability: 'x', summary: 'n' + i });
    const rows = log.tail(3);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.summary)).toEqual(['n4', 'n3', 'n2']);
  });

  it('坏行会被跳过，不影响其它行', () => {
    const log = makeLog();
    log.append({ channel: 'a', capability: 'x' });
    fs.appendFileSync(path.join(dir, 'agent-audit-' + dayKey(FIXED) + '.jsonl'), 'not-json\n', 'utf8');
    log.append({ channel: 'b', capability: 'y' });
    const rows = log.tail(5);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.channel)).toEqual(['b', 'a']);
  });
});

describe('可靠性', () => {
  it('目录不存在会自动创建', () => {
    const nested = path.join(dir, 'deep', 'agent');
    const log = createAuditLog({ dir: nested, now: () => FIXED, log: () => {} });
    expect(log.append({ channel: 'c', capability: 'x' }).ok).toBe(true);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('超过单文件上限就停写，并返回 full（不抛错）', () => {
    const log = makeLog({ maxBytes: 200 });
    const first = log.append({ channel: 'c', capability: 'x', summary: 'a'.repeat(50) });
    expect(first.ok).toBe(true);
    let last = null;
    for (let i = 0; i < 10; i += 1) last = log.append({ channel: 'c', capability: 'x', summary: 'b'.repeat(50) });
    expect(last.ok).toBe(false);
    expect(last.error).toBe('full');
  });

  it('目录不可写时不抛错', () => {
    const log = createAuditLog({ dir: path.join(dir, 'a.txt', 'sub'), now: () => FIXED, log: () => {} });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x', 'utf8'); // a.txt 是文件，下面建目录必然失败
    const r = log.append({ channel: 'c', capability: 'x' });
    expect(r.ok).toBe(false);
  });

  it('prune 只删超过保留期的审计文件', () => {
    const log = makeLog();
    log.append({ channel: 'c', capability: 'x' });
    const old = path.join(dir, 'agent-audit-2020-01-01.jsonl');
    fs.writeFileSync(old, '{}\n', 'utf8');
    fs.utimesSync(old, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    expect(log.prune(30)).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(log.tail(1)).toHaveLength(1);
  });
});

describe('sanitize', () => {
  it('清掉换行并截断超长摘要', () => {
    const row = sanitize({ channel: 'a\nb', capability: 'c', summary: 'x'.repeat(500) });
    expect(row.channel).toBe('a b');
    expect(row.summary.length).toBe(200);
  });
});

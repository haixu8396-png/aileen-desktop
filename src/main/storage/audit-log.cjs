'use strict';
// ============================================================
// Agent 审计日志（主进程，append-only JSONL）
//
// 任务书 3.5 要求「审计记录授权变更、工具、目标摘要、结果和时间；
// 不记录 API Key、密码、完整剪贴板或文件全文」。所以这里只写：
//   ts / channel / capability / risk / decision / reason / summary / taskId
//
// 三条设计取舍：
//   1) 按天一个文件（agent-audit-YYYY-MM-DD.jsonl）—— 单文件不会无限长，
//      用户想删哪一天就删哪一天。
//   2) 写失败只记 console，绝不抛给业务（审计坏了不能把 Agent 打死）。
//   3) 单文件超过上限就停止写入并记一条 audit-full（宁可少记，不撑爆磁盘）。
// ============================================================

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const KEEP_DAYS = 30;
const SUMMARY_LIMIT = 200;

function pad2(n) { return String(n).padStart(2, '0'); }

function dayKey(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

/** 只保留白名单字段，并把字符串截短（防御：调用方传进来一坨别的东西） */
function sanitize(entry) {
  const e = (entry && typeof entry === 'object') ? entry : {};
  const clip = (v, n) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').slice(0, n);
  return {
    ts: clip(e.ts || new Date().toISOString(), 40),
    channel: clip(e.channel, 60),
    capability: clip(e.capability, 40),
    risk: clip(e.risk, 12),
    decision: clip(e.decision, 12),
    reason: clip(e.reason, 80),
    summary: clip(e.summary, SUMMARY_LIMIT),
    taskId: clip(e.taskId, 60),
    ok: e.ok === true ? true : (e.ok === false ? false : null),
  };
}

function createAuditLog(opts = {}) {
  const dir = String(opts.dir || '');
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : DEFAULT_MAX_BYTES;
  if (!dir) throw new Error('audit-log 需要 dir');

  let disabled = false;

  function fileFor(date) {
    return path.join(dir, 'agent-audit-' + dayKey(date) + '.jsonl');
  }

  function ensureDir() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return true;
    } catch (err) {
      log('审计目录创建失败：' + String((err && err.message) || err));
      return false;
    }
  }

  /** 追加一条。返回 {ok}，永远不抛。 */
  function append(entry) {
    if (disabled) return { ok: false, error: 'full' };
    if (!ensureDir()) return { ok: false, error: 'no-dir' };
    const at = now();
    const date = at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date();
    const file = fileFor(date);
    const row = sanitize(Object.assign({ ts: date.toISOString() }, entry));
    let line = '';
    try {
      line = JSON.stringify(row);
    } catch {
      return { ok: false, error: 'serialize' };
    }
    try {
      let size = 0;
      try { size = fs.statSync(file).size; } catch { size = 0; }
      if (size + line.length + 1 > maxBytes) {
        disabled = true;
        log('审计文件已达上限，停止写入：' + file);
        return { ok: false, error: 'full' };
      }
      fs.appendFileSync(file, line + '\n', 'utf8');
      return { ok: true, file };
    } catch (err) {
      log('审计写入失败：' + String((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  /** 读最近 n 条（从最新的一天往回读，够 n 条就停）。只给「查看审计」界面/测试用。 */
  function tail(n = 50) {
    const want = Math.max(1, Math.min(500, Number(n) || 50));
    const out = [];
    for (let d = 0; d < 7 && out.length < want; d += 1) {
      const date = new Date(now().getTime() - d * 86400000);
      const file = fileFor(date);
      let text = '';
      try {
        if (!fs.existsSync(file)) continue;
        text = fs.readFileSync(file, 'utf8');
      } catch { continue; }
      const lines = text.split('\n').filter((l) => l.trim());
      const take = lines.slice(Math.max(0, lines.length - (want - out.length)));
      for (let i = take.length - 1; i >= 0; i -= 1) {
        try { out.push(JSON.parse(take[i])); } catch { /* 坏行跳过 */ }
      }
    }
    return out.slice(0, want);
  }

  /** 清理超过保留天数的文件（启动时调一次就够） */
  function prune(keepDays = KEEP_DAYS) {
    let removed = 0;
    try {
      if (!fs.existsSync(dir)) return 0;
      const cutoff = now().getTime() - keepDays * 86400000;
      for (const name of fs.readdirSync(dir)) {
        if (!/^agent-audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
        const file = path.join(dir, name);
        try {
          if (fs.statSync(file).mtimeMs < cutoff) { fs.unlinkSync(file); removed += 1; }
        } catch { /* 删不掉就算了 */ }
      }
    } catch (err) {
      log('审计清理失败：' + String((err && err.message) || err));
    }
    return removed;
  }

  return { dir, fileFor, append, tail, prune, sanitize, maxBytes };
}

module.exports = { createAuditLog, dayKey, sanitize, KEEP_DAYS, SUMMARY_LIMIT };

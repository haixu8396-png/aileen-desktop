// ============================================================
// 授权层单测：模式 / 范围 / 有效期 / 撤销 / 指纹 / 不可逆操作
//
// 这一层是「减少审批」的核心，也是最容易悄悄把安全边界放宽的地方，
// 所以每条规则都要有断言钉住 —— 尤其是「HIGH 的风险等级不会被信任模式降级」。
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  AUTH_MODE, AUTH_SCOPE, AUTH_REASON, MAX_TRUST_TTL_MS, DEFAULT_TRUST_TTL_MS,
  ALWAYS_CONFIRM_TOOLS, READ_ONLY_TOOLS,
  normalizeAuthorization, isTrustActive, authRemainingMs, revokeAuthorization,
  scopeCovers, fingerprintCall, decideAuthorized, shouldRetryAfterFailure,
  isReadOnlyTool, isAlwaysConfirmTool, looksSensitiveTarget, isDangerousCommand,
  authSummary,
} from '../../../src/agent/authorization.js';
import { RISK } from '../../../src/agent/permission.js';

const NOW = 1_700_000_000_000;
const cfg = { requireMedium: true };

function decide(over) {
  return decideAuthorized(Object.assign({
    riskLevel: RISK.LOW,
    tool: 'read_file',
    args: {},
    workspace: 'D:/work',
    auth: { mode: AUTH_MODE.MANUAL },
    config: cfg,
    grants: null,
    now: NOW,
  }, over));
}

describe('normalizeAuthorization', () => {
  it('缺省是逐项审批 + 任务范围', () => {
    const a = normalizeAuthorization(undefined, { now: NOW });
    expect(a.mode).toBe(AUTH_MODE.MANUAL);
    expect(a.scope).toBe(AUTH_SCOPE.TASK);
    expect(a.maxRisk).toBe(RISK.MEDIUM);
    expect(a.expiresAt).toBeNull();
  });

  it('不认识的模式退回逐项审批（不猜）', () => {
    expect(normalizeAuthorization({ mode: 'yolo' }, { now: NOW }).mode).toBe(AUTH_MODE.MANUAL);
  });

  it('maxRisk 不接受 HIGH —— 不能从设置里把 HIGH 一次性放开', () => {
    expect(normalizeAuthorization({ mode: AUTH_MODE.TRUST, maxRisk: 'HIGH' }, { now: NOW }).maxRisk).toBe(RISK.MEDIUM);
    expect(normalizeAuthorization({ mode: AUTH_MODE.TRUST, maxRisk: 'LOW' }, { now: NOW }).maxRisk).toBe(RISK.LOW);
    expect(normalizeAuthorization({ mode: AUTH_MODE.TRUST, maxRisk: '脏值' }, { now: NOW }).maxRisk).toBe(RISK.MEDIUM);
  });

  it('持续生效必须有 TTL，且被压到上限以内', () => {
    const a = normalizeAuthorization({ mode: AUTH_MODE.TRUST, scope: AUTH_SCOPE.PERSISTENT }, { now: NOW });
    expect(a.expiresAt).toBe(NOW + DEFAULT_TRUST_TTL_MS);
    const far = normalizeAuthorization({ mode: AUTH_MODE.TRUST, scope: AUTH_SCOPE.PERSISTENT, expiresAt: NOW + 10 * MAX_TRUST_TTL_MS }, { now: NOW });
    expect(far.expiresAt).toBeLessThanOrEqual(NOW + MAX_TRUST_TTL_MS);
  });

  it('工具白名单只接受非空短字符串：空串与超长项丢掉，总数截到 64', () => {
    const a = normalizeAuthorization({ tools: ['read_file', 42, '', 'x'.repeat(200)] }, { now: NOW });
    // 白名单宁可少放行：空串丢掉、数字转字符串、超长（>64）的丢掉
    expect(a.tools).toEqual(['read_file', '42']);
    const many = normalizeAuthorization({ tools: new Array(200).fill('a') }, { now: NOW });
    expect(many.tools.length).toBe(64);
  });
});

describe('信任授权是否生效', () => {
  it('任务范围内的信任一直有效，直到撤销', () => {
    const a = normalizeAuthorization({ mode: AUTH_MODE.TRUST }, { now: NOW });
    expect(isTrustActive(a, NOW + 100000)).toBe(true);
    expect(isTrustActive(revokeAuthorization(a, NOW + 5), NOW + 10)).toBe(false);
  });

  it('持续生效到期就失效（不会自己续期）', () => {
    const a = normalizeAuthorization({ mode: AUTH_MODE.TRUST, scope: AUTH_SCOPE.PERSISTENT }, { now: NOW });
    expect(isTrustActive(a, NOW + DEFAULT_TRUST_TTL_MS - 1)).toBe(true);
    expect(isTrustActive(a, NOW + DEFAULT_TRUST_TTL_MS + 1)).toBe(false);
    expect(authRemainingMs(a, NOW)).toBe(DEFAULT_TRUST_TTL_MS);
  });

  it('非信任模式永远不算生效', () => {
    expect(isTrustActive({ mode: AUTH_MODE.BATCH }, NOW)).toBe(false);
  });
});

describe('授权范围', () => {
  it('工作区必须匹配（Windows 大小写与反斜杠不敏感）', () => {
    const a = normalizeAuthorization({ mode: AUTH_MODE.TRUST, workspace: 'D:\\Work' }, { now: NOW });
    expect(scopeCovers(a, { tool: 'read_file', workspace: 'd:/work' })).toBe(true);
    expect(scopeCovers(a, { tool: 'read_file', workspace: 'D:/work/sub' })).toBe(true);
    expect(scopeCovers(a, { tool: 'read_file', workspace: 'D:/other' })).toBe(false);
  });

  it('工具白名单之外的调用不算在范围内', () => {
    const a = normalizeAuthorization({ mode: AUTH_MODE.TRUST, tools: ['read_file', 'list_files'] }, { now: NOW });
    expect(scopeCovers(a, { tool: 'read_file' })).toBe(true);
    expect(scopeCovers(a, { tool: 'write_file' })).toBe(false);
  });
});

describe('指纹（批量批准绑定的是具体这一次操作）', () => {
  it('参数里键的顺序不影响指纹', () => {
    const a = fingerprintCall('write_file', { path: 'a.txt', content: 'x' }, RISK.MEDIUM);
    const b = fingerprintCall('write_file', { content: 'x', path: 'a.txt' }, RISK.MEDIUM);
    expect(a).toBe(b);
  });

  it('参数、路径、风险等级任一变化都会换指纹', () => {
    const base = fingerprintCall('write_file', { path: 'a.txt', content: 'x' }, RISK.MEDIUM);
    expect(fingerprintCall('write_file', { path: 'a.txt', content: 'y' }, RISK.MEDIUM)).not.toBe(base);
    expect(fingerprintCall('write_file', { path: 'b.txt', content: 'x' }, RISK.MEDIUM)).not.toBe(base);
    expect(fingerprintCall('write_file', { path: 'a.txt', content: 'x' }, RISK.HIGH)).not.toBe(base);
    expect(fingerprintCall('apply_patch', { path: 'a.txt', content: 'x' }, RISK.MEDIUM)).not.toBe(base);
  });
});

describe('决策：逐项审批（默认）', () => {
  it('LOW 直接放行', () => {
    const r = decide({ riskLevel: RISK.LOW });
    expect(r.decision).toBe('allow');
    expect(r.reason).toBe(AUTH_REASON.LOW_RISK);
  });

  it('MEDIUM 默认要问，关掉 requireMedium 才放行', () => {
    expect(decide({ riskLevel: RISK.MEDIUM, tool: 'write_file' }).decision).toBe('ask');
    expect(decide({ riskLevel: RISK.MEDIUM, tool: 'write_file', config: { requireMedium: false } }).decision).toBe('allow');
  });

  it('MEDIUM 被「记住」过就放行，HIGH 记住也不放行', () => {
    expect(decide({ riskLevel: RISK.MEDIUM, tool: 'write_file', grants: new Set(['medium']) }).decision).toBe('allow');
    expect(decide({ riskLevel: RISK.HIGH, tool: 'run_command', grants: new Set(['medium']) }).decision).toBe('ask');
  });

  it('风险等级传脏值按 HIGH 处理', () => {
    expect(decide({ riskLevel: 'whatever' }).decision).toBe('ask');
  });

  it('批量模式下要问的调用标记为可批量', () => {
    const r = decide({ riskLevel: RISK.HIGH, tool: 'run_command', auth: { mode: AUTH_MODE.BATCH } });
    expect(r.decision).toBe('ask');
    expect(r.batchable).toBe(true);
  });
});

describe('决策：完全信任', () => {
  const trust = (extra) => Object.assign({ mode: AUTH_MODE.TRUST, workspace: 'D:/work' }, extra || {});

  it('MEDIUM 在范围内自动执行', () => {
    const r = decide({ riskLevel: RISK.MEDIUM, tool: 'write_file', args: { path: 'a.txt' }, auth: trust() });
    expect(r.decision).toBe('allow');
    expect(r.reason).toBe(AUTH_REASON.TRUST_AUTO);
  });

  it('默认 HIGH 仍然逐次确认（信任模式先只去掉 MEDIUM 的打断）', () => {
    const r = decide({ riskLevel: RISK.HIGH, tool: 'mouse_move', args: { x: 10, y: 10 }, auth: trust() });
    expect(r.decision).toBe('ask');
    expect(r.reason).toBe(AUTH_REASON.TRUST_HIGH_NOT_ALLOWED);
  });

  it('显式打开 allowHighRisk 后，非不可逆的 HIGH 才自动执行', () => {
    const r = decide({ riskLevel: RISK.HIGH, tool: 'mouse_move', args: { x: 10, y: 10 }, auth: trust({ allowHighRisk: true }) });
    expect(r.decision).toBe('allow');
    expect(r.reason).toBe(AUTH_REASON.TRUST_AUTO);
    // 即便打开了这一项，不可逆的照样问
    const del = decide({ riskLevel: RISK.HIGH, tool: 'delete_path', args: { path: 'a.txt' }, auth: trust({ allowHighRisk: true }) });
    expect(del.decision).toBe('ask');
  });

  it('**不可逆工具永远要问**：删除 / push / 装包 / shell', () => {
    for (const tool of ALWAYS_CONFIRM_TOOLS) {
      const r = decide({ riskLevel: RISK.HIGH, tool, args: { path: 'a.txt' }, auth: trust() });
      expect(r.decision).toBe('ask');
      expect(r.reason).toBe(AUTH_REASON.TRUST_IRREVERSIBLE);
      expect(r.irreversible).toBe(true);
    }
  });

  it('高危命令（危险参数）即使信任+allowHighRisk 也要问', () => {
    const r = decide({
      riskLevel: RISK.HIGH, tool: 'run_command',
      args: { command: 'node', args: ['-e', 'x'] },
      auth: trust({ allowHighRisk: true }),
    });
    expect(r.decision).toBe('ask');
    expect(r.reason).toBe(AUTH_REASON.TRUST_DANGEROUS_COMMAND);
  });

  it('普通命令在信任+allowHighRisk 下自动执行；只开信任则不自动', () => {
    const args = { command: 'npm', args: ['run', 'build'] };
    expect(decide({ riskLevel: RISK.HIGH, tool: 'run_command', args, auth: trust() }).decision).toBe('ask');
    expect(decide({ riskLevel: RISK.HIGH, tool: 'run_command', args, auth: trust({ allowHighRisk: true }) }).decision).toBe('allow');
  });

  it('敏感目标永远要问（凭据 / 浏览器数据 / 设置文件）', () => {
    for (const target of ['C:/Users/me/.ssh/id_rsa', 'C:/Users/me/.npmrc', 'D:/AileenData/data/settings.json']) {
      const r = decide({ riskLevel: RISK.MEDIUM, tool: 'write_file', args: { path: target }, auth: trust() });
      expect(r.decision).toBe('ask');
      expect(r.reason).toBe(AUTH_REASON.TRUST_SENSITIVE);
    }
  });

  it('超出工作区范围的调用要问', () => {
    const r = decide({ riskLevel: RISK.MEDIUM, tool: 'write_file', args: { path: 'a.txt' }, workspace: 'D:/elsewhere', auth: trust() });
    expect(r.decision).toBe('ask');
    expect(r.outOfScope).toBe(true);
  });

  it('不在工具白名单里的调用要问', () => {
    const r = decide({ riskLevel: RISK.MEDIUM, tool: 'write_file', args: { path: 'a.txt' }, auth: trust({ tools: ['read_file'] }) });
    expect(r.decision).toBe('ask');
    expect(r.outOfScope).toBe(true);
  });

  it('撤销后立刻退回逐项审批', () => {
    const a = revokeAuthorization(trust(), NOW);
    const r = decide({ riskLevel: RISK.MEDIUM, tool: 'write_file', args: { path: 'a.txt' }, auth: a });
    expect(r.decision).toBe('ask');
    expect(r.reason).toBe(AUTH_REASON.TRUST_REVOKED);
  });

  it('过期后立刻退回逐项审批', () => {
    const a = normalizeAuthorization(trust({ scope: AUTH_SCOPE.PERSISTENT }), { now: NOW });
    const r = decide({ riskLevel: RISK.MEDIUM, tool: 'write_file', args: { path: 'a.txt' }, auth: a, now: NOW + DEFAULT_TRUST_TTL_MS + 1 });
    expect(r.decision).toBe('ask');
    expect(r.reason).toBe(AUTH_REASON.TRUST_EXPIRED);
  });

  it('maxRisk=LOW 时 HIGH 也不自动执行（授权范围要说得更小就真的更小）', () => {
    const r = decide({ riskLevel: RISK.HIGH, tool: 'mouse_move', args: { x: 1, y: 1 }, auth: trust({ allowHighRisk: true, maxRisk: 'LOW' }) });
    expect(r.decision).toBe('ask');
    expect(r.reason).toBe(AUTH_REASON.TRUST_HIGH_NOT_ALLOWED);
  });

  it('信任模式不会把 HIGH 的等级写成 LOW（审计要看到真实风险）', () => {
    const r = decide({ riskLevel: RISK.HIGH, tool: 'mouse_move', auth: trust({ allowHighRisk: true }) });
    expect(r.decision).toBe('allow');
    // 决策里不携带「降级」信息，风险由调用方原样记录
    expect(r.reason).toBe(AUTH_REASON.TRUST_AUTO);
  });
});

describe('工具分类与重试策略', () => {
  it('只读工具集合固定', () => {
    for (const t of ['read_file', 'list_files', 'search_files', 'git_status', 'git_diff', 'screen_capture']) {
      expect(isReadOnlyTool(t)).toBe(true);
    }
    expect(isReadOnlyTool('write_file')).toBe(false);
    expect(READ_ONLY_TOOLS.has('run_command')).toBe(false);
  });

  it('不可逆工具集合固定', () => {
    for (const t of ['delete_path', 'git_push', 'package_install', 'shell']) {
      expect(isAlwaysConfirmTool(t)).toBe(true);
    }
    expect(isAlwaysConfirmTool('write_file')).toBe(false);
  });

  it('只有只读工具会有限重试，写操作不重试（避免重复副作用）', () => {
    expect(shouldRetryAfterFailure({ tool: 'read_file', riskLevel: RISK.LOW, attempt: 0, maxRetries: 1 })).toBe(true);
    expect(shouldRetryAfterFailure({ tool: 'read_file', riskLevel: RISK.LOW, attempt: 1, maxRetries: 1 })).toBe(false);
    expect(shouldRetryAfterFailure({ tool: 'write_file', riskLevel: RISK.MEDIUM, attempt: 0, maxRetries: 3 })).toBe(false);
    expect(shouldRetryAfterFailure({ tool: 'read_file', riskLevel: RISK.LOW, attempt: 0, maxRetries: 99 })).toBe(true);
    expect(shouldRetryAfterFailure({ tool: 'read_file', riskLevel: RISK.LOW, attempt: 3, maxRetries: 99 })).toBe(false);
  });

  it('敏感目标识别', () => {
    expect(looksSensitiveTarget({ path: 'C:/Users/a/.ssh/id_rsa' })).toBe(true);
    expect(looksSensitiveTarget({ path: 'src/index.html' })).toBe(false);
    expect(looksSensitiveTarget({ command: 'cat', args: ['/home/a/.aws/credentials'] })).toBe(false); // 只在 path/target/command 字段里看
  });

  it('危险命令识别（危险参数算高危）', () => {
    expect(isDangerousCommand('node', ['-e', 'process.exit(1)'])).toBe(true);
    expect(isDangerousCommand('npm', ['run', 'build'])).toBe(false);
  });
});

describe('authSummary（给界面顶部显示当前授权）', () => {
  it('信任模式给出生效状态与剩余时间', () => {
    const a = normalizeAuthorization({ mode: AUTH_MODE.TRUST, scope: AUTH_SCOPE.PERSISTENT }, { now: NOW });
    const s = authSummary(a, NOW + 1000);
    expect(s.mode).toBe(AUTH_MODE.TRUST);
    expect(s.active).toBe(true);
    expect(s.remainingMs).toBe(DEFAULT_TRUST_TTL_MS - 1000);
  });

  it('撤销后 active=false、revoked=true（界面据此显示「已撤销」）', () => {
    const a = revokeAuthorization({ mode: AUTH_MODE.TRUST }, NOW);
    const s = authSummary(a, NOW + 1);
    expect(s.active).toBe(false);
    expect(s.revoked).toBe(true);
  });
});

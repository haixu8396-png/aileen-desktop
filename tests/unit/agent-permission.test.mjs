import { describe, it, expect } from 'vitest';
import {
  RISK, DECISION, TOOL_RISK, riskForTool, decide, normalizePermissionConfig, describeApproval, isRiskLevel,
} from '../../src/agent/permission.js';

describe('风险分级', () => {
  it('只读类工具是 LOW', () => {
    for (const name of ['list_files', 'search_files', 'read_file', 'git_status', 'git_diff', 'screen_capture']) {
      expect(riskForTool({ name })).toBe(RISK.LOW);
    }
  });
  it('写文件 / 打补丁 / git commit 是 MEDIUM', () => {
    for (const name of ['write_file', 'apply_patch', 'git_commit', 'mc_action']) {
      expect(riskForTool({ name })).toBe(RISK.MEDIUM);
    }
  });
  it('跑命令 / 删除 / push / 装包 / shell 是 HIGH', () => {
    for (const name of ['run_command', 'delete_path', 'git_push', 'package_install', 'shell']) {
      expect(riskForTool({ name })).toBe(RISK.HIGH);
    }
  });
  it('未知工具默认 HIGH（宁可多问一句）', () => {
    expect(riskForTool({ name: 'never_heard_of_it' })).toBe(RISK.HIGH);
    expect(riskForTool(null)).toBe(RISK.HIGH);
  });
  it('工具自己声明的 riskLevel 优先于表', () => {
    expect(riskForTool({ name: 'write_file', riskLevel: RISK.LOW })).toBe(RISK.LOW);
    expect(riskForTool({ name: 'read_file', riskLevel: 'BOGUS' })).toBe(RISK.LOW);
  });
  it('isRiskLevel', () => {
    expect(isRiskLevel('LOW')).toBe(true);
    expect(isRiskLevel('low')).toBe(false);
    expect(isRiskLevel(undefined)).toBe(false);
  });
});

describe('权限决策', () => {
  const cfg = normalizePermissionConfig({});

  it('LOW 默认允许', () => {
    expect(decide({ riskLevel: RISK.LOW, config: cfg })).toBe(DECISION.ALLOW);
  });
  it('MEDIUM 默认要问', () => {
    expect(decide({ riskLevel: RISK.MEDIUM, config: cfg })).toBe(DECISION.ASK);
  });
  it('MEDIUM 关掉「写文件要确认」后直接放行', () => {
    const off = normalizePermissionConfig({ requireMedium: false });
    expect(decide({ riskLevel: RISK.MEDIUM, config: off })).toBe(DECISION.ALLOW);
  });
  it('MEDIUM 记住过一次就放行同一个等级的后续调用', () => {
    expect(decide({ riskLevel: RISK.MEDIUM, config: cfg, grants: new Set(['medium']) })).toBe(DECISION.ALLOW);
  });
  it('HIGH 永远要问 —— 设置不能绕过', () => {
    const evil = normalizePermissionConfig({ requireMedium: false, allowHighRisk: true, whitelist: ['run_command'] });
    expect(decide({ riskLevel: RISK.HIGH, config: evil })).toBe(DECISION.ASK);
    expect(evil.allowHighRisk).toBeUndefined();
    expect(evil.whitelist).toBeUndefined();
  });
  it('HIGH 即便「记住过」也照样问', () => {
    const grants = new Set(['medium', 'high', 'run_command', 'HIGH']);
    expect(decide({ riskLevel: RISK.HIGH, config: cfg, grants })).toBe(DECISION.ASK);
  });
  it('风险等级传了脏值按 HIGH 处理', () => {
    expect(decide({ riskLevel: 'WHATEVER', config: cfg })).toBe(DECISION.ASK);
    expect(decide({ config: cfg })).toBe(DECISION.ASK);
  });
  it('配置缺省时按「写文件要确认」', () => {
    expect(normalizePermissionConfig(undefined).requireMedium).toBe(true);
    expect(normalizePermissionConfig({ requireMedium: false }).requireMedium).toBe(false);
  });
});

describe('审批文案', () => {
  it('跑命令会带上完整命令', () => {
    const text = describeApproval({ name: 'run_command' }, { command: 'npm run build' });
    expect(text).toContain('npm run build');
  });
  it('写文件会带上路径与字数', () => {
    const text = describeApproval({ name: 'write_file' }, { path: 'src/a.js', content: 'x'.repeat(50) });
    expect(text).toContain('src/a.js');
    expect(text).toContain('50');
  });
  it('超长内容会截断', () => {
    const text = describeApproval({ name: 'run_command' }, { command: 'a'.repeat(1000) });
    expect(text.length).toBeLessThan(360);
  });
  it('未知工具有兜底文案', () => {
    expect(describeApproval({ name: 'weird_tool' }, { a: 1 })).toContain('weird_tool');
  });
  it('工具表完整性：每个风险名都有说明', () => {
    expect(Object.keys(TOOL_RISK).length).toBeGreaterThanOrEqual(13);
  });
});

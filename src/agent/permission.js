// ============================================================
// 权限层：Agent → Tool → Permission → Executor
//
// 三档风险：
//   LOW    —— 默认允许（只读类：看文件、搜文件、看 git 状态）
//   MEDIUM —— 按设置决定要不要问（写文件、打补丁、git commit）
//   HIGH   —— **必须用户确认**，且设置不可绕过（跑命令、删除、git push、装包、shell）
//
// 「不可绕过」是硬约束，不是默认值：allowHighRisk 这种设置项压根不存在，
// 即便有人往设置里塞 agent.allowHighRisk=true，decision 也照样回 'ask'。
// ============================================================

export const RISK = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
};

export const RISK_ORDER = [RISK.LOW, RISK.MEDIUM, RISK.HIGH];

/** 决策结果 */
export const DECISION = {
  ALLOW: 'allow',   // 直接执行
  ASK: 'ask',       // 等用户批准
  DENY: 'deny',     // 拒绝（策略不允许）
};

export function isRiskLevel(value) {
  return RISK_ORDER.includes(value);
}

/**
 * 风险分级：显式声明的 riskLevel 优先，否则按工具名查表。
 * 表里没有的工具**默认 HIGH** —— 未知的东西宁可多问一句。
 */
export const TOOL_RISK = {
  list_files: RISK.LOW,
  search_files: RISK.LOW,
  read_file: RISK.LOW,
  git_status: RISK.LOW,
  git_diff: RISK.LOW,
  screen_capture: RISK.LOW,

  write_file: RISK.MEDIUM,
  apply_patch: RISK.MEDIUM,
  git_commit: RISK.MEDIUM,
  mc_action: RISK.MEDIUM,

  run_command: RISK.HIGH,
  delete_path: RISK.HIGH,
  git_push: RISK.HIGH,
  package_install: RISK.HIGH,
  shell: RISK.HIGH,
};

export function riskForTool(tool) {
  if (tool && isRiskLevel(tool.riskLevel)) return tool.riskLevel;
  const name = String((tool && tool.name) || '');
  return TOOL_RISK[name] || RISK.HIGH;
}

/**
 * 权限配置归一化。只认这三个字段，别的都丢掉。
 * requireMedium 默认 true：写文件这件事默认要问一声。
 */
export function normalizePermissionConfig(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  return {
    requireMedium: r.requireMedium === undefined ? true : !!r.requireMedium,
    // 允许用户在本次会话里「记住」某个工具的选择，但不接受预设的白名单数组
    // —— 预设白名单等于把 HIGH 绕过去，不允许从设置里进来。
  };
}

/**
 * 决策。
 * @param {object} params
 *   riskLevel    风险等级
 *   config       normalizePermissionConfig 的结果
 *   grants       Map/Set：本次会话已记住批准的工具名（"name" 或 "name:risk"）
 * @returns {'allow'|'ask'|'deny'}
 */
export function decide({ riskLevel, config, grants } = {}) {
  const level = isRiskLevel(riskLevel) ? riskLevel : RISK.HIGH;
  const cfg = normalizePermissionConfig(config);
  const granted = (name) => {
    if (!grants) return false;
    if (typeof grants.has === 'function') return grants.has(name);
    if (Array.isArray(grants)) return grants.includes(name);
    return false;
  };

  if (level === RISK.LOW) return DECISION.ALLOW;

  if (level === RISK.MEDIUM) {
    if (!cfg.requireMedium) return DECISION.ALLOW;
    return granted('medium') ? DECISION.ALLOW : DECISION.ASK;
  }

  // HIGH：永远要问。「记住」也不放行 —— 这是刻意的。
  return DECISION.ASK;
}

/**
 * 人话说明这次要干什么，用于审批卡片。
 * 不给完整参数（可能很长），只给一眼能判断的关键信息。
 */
export function describeApproval(tool, args) {
  const name = String((tool && tool.name) || '未知工具');
  const a = (args && typeof args === 'object') ? args : {};
  const clip = (v, n = 160) => {
    const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  };
  switch (name) {
    case 'run_command':
      return '要执行命令：' + clip(a.command || a.cmd, 300);
    case 'write_file':
      return '要写入文件：' + clip(a.path, 200) + '（' + String(a.content || '').length + ' 字符）';
    case 'apply_patch':
      return '要修改文件：' + clip(a.path, 200);
    case 'git_commit':
      return '要提交：' + clip(a.message, 200);
    case 'delete_path':
      return '要删除：' + clip(a.path, 200);
    default:
      return '要执行 ' + name + '：' + clip(JSON.stringify(a), 200);
  }
}

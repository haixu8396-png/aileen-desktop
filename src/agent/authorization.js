// ============================================================
// 授权层：在「三档风险」之上加一层**有范围、有期限、可撤销**的用户授权
//
// 三种模式（对应用户要求的三档审批体验）：
//   manual  逐项审批  —— 现有行为：LOW 放行，MEDIUM 看设置，HIGH 必问
//   batch   批量确认  —— MEDIUM/HIGH 汇总成一张列表，一次性批/驳，也可逐项
//   trust   完全信任  —— 在授权范围内自动执行「通常要问」的操作
//
// 三条硬边界（无论哪种模式都不放宽）：
//   1. **风险等级不会被降低**。信任模式只是「不再逐次打断」，不是把 HIGH 说成 LOW。
//   2. **不可逆操作永远单独确认**：删除、git push、装包、shell，
//      以及明显会造成严重不可逆后果的命令，即使在信任模式下也照样问。
//   3. **超出授权范围的操作照样问**：范围 = 工作区 + 工具白名单 + 有效期。
//      一次批准不会变成无限放权：batch 的批准只绑定已确认的那批操作指纹，
//      trust 有 TTL、可以被随时撤销，且默认只对当前任务生效。
//
// 这一层是**纯函数**：不读设置、不碰 fs、不认识 DOM/Electron，
// 所以它能被单测完整覆盖，runtime 只负责按决策执行。
// ============================================================
import { RISK, RISK_ORDER, isRiskLevel } from './permission.js';
import { checkCommand } from './executor.js';

export const AUTH_MODE = {
  MANUAL: 'manual',
  BATCH: 'batch',
  TRUST: 'trust',
};

export const AUTH_SCOPE = {
  TASK: 'task',            // 仅当前任务生效（默认）
  PERSISTENT: 'persistent', // 持续生效（必须用户单独选择，可随时撤销）
};

/**
 * 完全信任模式的第二个开关：是否允许自动执行 HIGH 风险（非不可逆）的操作。
 *
 * 默认 **false** —— 也就是说「信任模式」先把 MEDIUM 的重复打断去掉，
 * HIGH（跑命令、动鼠标键盘、开程序）仍然逐次确认。用户要更省事，必须
 * 显式再打开这一项，界面上会单独提示风险。这样既减少打断，
 * 又不会出现「打开一个开关就把整台机器交出去」。
 */
export const DEFAULT_ALLOW_HIGH_RISK = false;

/** 信任模式默认有效期：30 分钟；最长 8 小时（防止「开一次挂一天」） */
export const DEFAULT_TRUST_TTL_MS = 30 * 60 * 1000;
export const MAX_TRUST_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * 永远要单独确认的工具：不可逆或影响面超出工作区。
 * 名单里的东西**不会**被信任模式自动放行，也不会因为「记住批准」而放行。
 */
export const ALWAYS_CONFIRM_TOOLS = new Set([
  'delete_path',
  'git_push',
  'package_install',
  'shell',
]);

/** 只读工具：可以安全并行，失败也可以有限次重试 */
export const READ_ONLY_TOOLS = new Set([
  'list_files',
  'search_files',
  'read_file',
  'git_status',
  'git_diff',
  'screen_capture',
]);

/** 敏感目标（凭据 / 浏览器数据 / 设置文件）—— 即使在工作区内也不自动放行 */
const SENSITIVE_PATTERNS = [
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.gnupg([\\/]|$)/i,
  /(^|[\\/])\.git-credentials$/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])id_(rsa|ed25519|ecdsa)(\.pub)?$/i,
  /(^|[\\/])(Login Data|Cookies|Web Data)$/i,
  /(^|[\\/])(Google[\\/]Chrome|Microsoft[\\/]Edge|Mozilla[\\/]Firefox)/i,
  /(^|[\\/])settings\.json$/i,
  /(^|[\\/])\.credentials\.yaml$/i,
];

/** 决策理由代码：给审计日志与界面用（界面负责翻译，这里只给代码） */
export const AUTH_REASON = {
  LOW_RISK: 'low-risk',
  MEDIUM_NOT_REQUIRED: 'medium-not-required',
  MEDIUM_GRANTED: 'medium-granted',
  MEDIUM_ASK: 'medium-ask',
  HIGH_ASK: 'high-ask',
  TRUST_AUTO: 'trust-auto',
  TRUST_EXPIRED: 'trust-expired',
  TRUST_REVOKED: 'trust-revoked',
  TRUST_IRREVERSIBLE: 'trust-irreversible',
  TRUST_SENSITIVE: 'trust-sensitive',
  TRUST_DANGEROUS_COMMAND: 'trust-dangerous-command',
  TRUST_OUT_OF_SCOPE: 'trust-out-of-scope',
  TRUST_HIGH_NOT_ALLOWED: 'trust-high-not-allowed',
};

export function isReadOnlyTool(name) {
  return READ_ONLY_TOOLS.has(String(name || ''));
}

export function isAlwaysConfirmTool(name) {
  return ALWAYS_CONFIRM_TOOLS.has(String(name || ''));
}

/** args 里是否指向敏感目标（只需要看路径类字段，不必全量遍历大对象） */
export function looksSensitiveTarget(args) {
  const a = (args && typeof args === 'object') ? args : {};
  const candidates = [a.path, a.target, a.cwd, a.file, a.dest, a.to, a.command];
  for (const value of candidates) {
    if (value === undefined || value === null) continue;
    const s = String(value);
    if (SENSITIVE_PATTERNS.some((re) => re.test(s))) return true;
    // 命令里出现敏感路径也算（`cat ~/.ssh/id_rsa` 这种）
    if (a.command && SENSITIVE_PATTERNS.some((re) => re.test(s))) return true;
  }
  return false;
}

/** 跑命令这件事本身是否「高危」：走 executor 的命令策略，危险参数一律算 */
export function isDangerousCommand(command, args) {
  const cmd = String(command || '');
  if (!cmd) return false;
  const parsed = { ok: true };
  try {
    const res = checkCommand(cmd, Array.isArray(args) ? args : []);
    parsed.ok = res && res.ok !== false;
  } catch {
    parsed.ok = false;
  }
  return !parsed.ok;
}

/** 归一化路径，用于范围比较（Windows 大小写不敏感） */
function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 归一化授权配置。**不认识的字段一律丢掉**，避免从设置里塞进
 * 「允许 HIGH 的工具白名单」这类东西。
 */
export function normalizeAuthorization(raw, { now = Date.now() } = {}) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const mode = Object.values(AUTH_MODE).includes(r.mode) ? r.mode : AUTH_MODE.MANUAL;
  const scope = r.scope === AUTH_SCOPE.PERSISTENT ? AUTH_SCOPE.PERSISTENT : AUTH_SCOPE.TASK;

  // 自动放行的最高风险：只接受 LOW / MEDIUM。HIGH 只能靠「不可逆名单之外 +
  // 范围之内」这两条同时成立时才自动执行，不接受把 maxRisk 设成 HIGH。
  const maxRisk = isRiskLevel(r.maxRisk) && r.maxRisk !== RISK.HIGH ? r.maxRisk : RISK.MEDIUM;

  const tools = Array.isArray(r.tools)
    ? r.tools.map((x) => String(x)).filter((x) => x && x.length <= 64).slice(0, 64)
    : null;

  const workspace = String(r.workspace || '').slice(0, 1000);

  // 有效期：任务范围内 = 到任务结束（expiresAt 为 null，由任务生命周期决定）；
  // 持续生效 = 必须有 TTL，缺省 DEFAULT_TRUST_TTL_MS，上限 MAX_TRUST_TTL_MS。
  let expiresAt = null;
  if (mode === AUTH_MODE.TRUST && scope === AUTH_SCOPE.PERSISTENT) {
    const want = Number.isFinite(r.expiresAt) ? Number(r.expiresAt) : now + DEFAULT_TRUST_TTL_MS;
    expiresAt = Math.min(want, now + MAX_TRUST_TTL_MS);
  }

  return {
    mode,
    scope,
    maxRisk,
    /** 是否允许自动执行 HIGH（非不可逆）：默认否，必须显式打开 */
    allowHighRisk: r.allowHighRisk === true,
    tools,
    workspace,
    expiresAt,
    grantedAt: Number.isFinite(r.grantedAt) ? Number(r.grantedAt) : (mode === AUTH_MODE.TRUST ? now : null),
    revokedAt: Number.isFinite(r.revokedAt) ? Number(r.revokedAt) : null,
  };
}

/** 信任授权此刻是否生效 */
export function isTrustActive(auth, now = Date.now()) {
  const a = normalizeAuthorization(auth, { now });
  if (a.mode !== AUTH_MODE.TRUST) return false;
  if (a.revokedAt) return false;
  if (a.scope === AUTH_SCOPE.PERSISTENT && a.expiresAt && now >= a.expiresAt) return false;
  return true;
}

/** 剩余毫秒（仅持续生效有）；null 表示「跟随任务」 */
export function authRemainingMs(auth, now = Date.now()) {
  const a = normalizeAuthorization(auth, { now });
  if (a.scope !== AUTH_SCOPE.PERSISTENT || !a.expiresAt) return null;
  return Math.max(0, a.expiresAt - now);
}

/** 撤销：返回新的授权对象（不原地改，避免共享引用） */
export function revokeAuthorization(auth, now = Date.now()) {
  const a = normalizeAuthorization(auth, { now });
  return Object.assign({}, a, { revokedAt: now });
}

/** 授权是否覆盖这次调用（工作区 + 工具白名单） */
export function scopeCovers(auth, { tool, workspace } = {}) {
  const a = normalizeAuthorization(auth, { now: Date.now() });
  if (a.tools && a.tools.length && !a.tools.includes(String(tool || ''))) return false;
  if (a.workspace) {
    const want = normPath(a.workspace);
    const got = normPath(workspace);
    // 调用方没给 workspace（单测/无工作区场景）时不因此判定越界
    if (got && want && got !== want && !got.startsWith(want + '/')) return false;
  }
  return true;
}

// ---- 操作指纹：批量批准要绑定「确认过的那一次操作」 ----

/** 稳定序列化（键排序），避免同一对象因为键顺序不同算出不同指纹 */
function stableStringify(value, depth = 0) {
  if (depth > 6) return '"[deep]"';
  if (value === null || value === undefined) return 'null';
  const type = typeof value;
  if (type === 'number' || type === 'boolean') return String(value);
  if (type === 'string') return JSON.stringify(value.length > 2000 ? value.slice(0, 2000) : value);
  if (type !== 'object') return JSON.stringify(String(value));
  if (Array.isArray(value)) {
    return '[' + value.slice(0, 100).map((v) => stableStringify(v, depth + 1)).join(',') + ']';
  }
  const keys = Object.keys(value).filter((k) => k !== 'signal' && k !== 'workspace').sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k], depth + 1)).join(',') + '}';
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 一次工具调用的指纹：工具名 + 参数 + 风险等级。
 * 参数、目标路径或风险等级任何一项变了，指纹就变 —— 已批准的那次不覆盖新操作。
 */
export function fingerprintCall(name, args, riskLevel) {
  return fnv1a(String(name || '') + '|' + String(riskLevel || '') + '|' + stableStringify(args || {}));
}

/**
 * 核心决策。
 *
 * @param {object} p
 *   riskLevel  实际风险（不会被降低）
 *   tool       工具名
 *   args       解析后的参数
 *   workspace  本次 run 的工作区
 *   auth       normalizeAuthorization 的结果
 *   config     normalizePermissionConfig 的结果（requireMedium）
 *   grants     Set/Array：本次运行已记住批准过的等级（"medium"）
 *   now        注入时间（测试）
 * @returns {{decision:'allow'|'ask'|'deny', reason:string, batchable:boolean,
 *            irreversible:boolean, outOfScope:boolean, auto:boolean}}
 */
export function decideAuthorized({
  riskLevel, tool, args, workspace, auth, config, grants, now = Date.now(),
} = {}) {
  const level = isRiskLevel(riskLevel) ? riskLevel : RISK.HIGH;
  const name = String(tool || '');
  const a = normalizeAuthorization(auth, { now });
  const cfg = (config && typeof config === 'object') ? config : { requireMedium: true };
  const granted = (key) => {
    if (!grants) return false;
    if (typeof grants.has === 'function') return grants.has(key);
    if (Array.isArray(grants)) return grants.includes(key);
    return false;
  };
  const out = (decision, reason, extra = {}) => Object.assign({
    decision,
    reason,
    batchable: decision === 'ask' && (a.mode === AUTH_MODE.BATCH || a.mode === AUTH_MODE.MANUAL),
    irreversible: false,
    outOfScope: false,
    auto: decision === 'allow',
  }, extra);

  // 1) 只读：任何模式都放行
  if (level === RISK.LOW) return out('allow', AUTH_REASON.LOW_RISK);

  const irreversible = isAlwaysConfirmTool(name);
  const sensitive = looksSensitiveTarget(args);
  const dangerousCmd = name === 'run_command' && isDangerousCommand(args && args.command, args && args.args);
  const inScope = scopeCovers(a, { tool: name, workspace });

  // 2) 信任模式：只放宽「范围之内 + 非不可逆 + 非敏感」的中高风险
  const trustWanted = a.mode === AUTH_MODE.TRUST;
  if (trustWanted) {
    if (a.revokedAt) {
      // 已撤销：退回逐项审批，但把原因说清楚（审计里能看到）
      if (level === RISK.MEDIUM) return out(cfg.requireMedium ? 'ask' : 'allow', AUTH_REASON.TRUST_REVOKED);
      return out('ask', AUTH_REASON.TRUST_REVOKED);
    }
    if (!isTrustActive(a, now)) {
      if (level === RISK.MEDIUM) return out(cfg.requireMedium ? 'ask' : 'allow', AUTH_REASON.TRUST_EXPIRED);
      return out('ask', AUTH_REASON.TRUST_EXPIRED);
    }
    if (!inScope) return out('ask', AUTH_REASON.TRUST_OUT_OF_SCOPE, { outOfScope: true, irreversible });
    if (irreversible) return out('ask', AUTH_REASON.TRUST_IRREVERSIBLE, { irreversible: true });
    if (sensitive) return out('ask', AUTH_REASON.TRUST_SENSITIVE, { irreversible });
    if (dangerousCmd) return out('ask', AUTH_REASON.TRUST_DANGEROUS_COMMAND, { irreversible: true });
    // HIGH：默认仍然逐次确认；只有用户显式打开 allowHighRisk 才自动执行
    if (level === RISK.HIGH && !a.allowHighRisk) return out('ask', AUTH_REASON.TRUST_HIGH_NOT_ALLOWED);
    if (level === RISK.HIGH && a.maxRisk === RISK.LOW) return out('ask', AUTH_REASON.TRUST_HIGH_NOT_ALLOWED);
    return out('allow', AUTH_REASON.TRUST_AUTO);
  }

  // 3) 逐项 / 批量：风险等级决定要不要问
  if (level === RISK.MEDIUM) {
    if (cfg.requireMedium === false) return out('allow', AUTH_REASON.MEDIUM_NOT_REQUIRED);
    if (granted('medium')) return out('allow', AUTH_REASON.MEDIUM_GRANTED);
    return out('ask', AUTH_REASON.MEDIUM_ASK, { irreversible });
  }
  return out('ask', AUTH_REASON.HIGH_ASK, { irreversible });
}

/**
 * 失败重试策略：只对**只读工具**做有限次自动重试。
 * 写操作重试可能造成重复副作用（追加两次、提交两次），交给模型自己决定。
 */
export function shouldRetryAfterFailure({ tool, attempt, maxRetries = 1, riskLevel } = {}) {
  const level = isRiskLevel(riskLevel) ? riskLevel : RISK.HIGH;
  if (level !== RISK.LOW) return false;
  if (!isReadOnlyTool(tool)) return false;
  const tries = Number.isFinite(attempt) ? attempt : 0;
  const limit = Math.max(0, Math.min(3, Number.isFinite(maxRetries) ? maxRetries : 1));
  return tries < limit;
}

/** 给界面的一句话摘要（不含翻译文案，界面自己翻译） */
export function authSummary(auth, now = Date.now()) {
  const a = normalizeAuthorization(auth, { now });
  const active = a.mode === AUTH_MODE.TRUST && isTrustActive(a, now);
  return {
    mode: a.mode,
    scope: a.scope,
    active,
    revoked: !!a.revokedAt,
    expiresAt: a.expiresAt,
    remainingMs: authRemainingMs(a, now),
    tools: a.tools,
    workspace: a.workspace,
    maxRisk: a.maxRisk,
    allowHighRisk: a.allowHighRisk,
  };
}

export { RISK, RISK_ORDER, isRiskLevel, normPath };

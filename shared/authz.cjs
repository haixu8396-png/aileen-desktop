'use strict';
// ============================================================
// 授权中心（唯一策略来源，主进程与渲染层共用）
//
// 为什么要有这个文件：
//   以前「要不要问用户」的判断只写在渲染层的 src/agent/authorization.js 里，
//   主进程对 agent:input / agent:open / agent:exec 只看参数格式，不看授权 —— 
//   于是「渲染层被注入」就等于「绕过全部审批」。任务书 3.4 要求主进程做最终判定，
//   所以策略必须放在一个两边都能读、且主进程真正执行的地方。
//
// 分工：
//   · 本文件：能力表（capability）、风险、策略判定（纯函数）、一次性授权凭证（grant）
//   · 主进程 shared/agent-ipc.cjs：每次动作前先 gate()，没有凭证就拒绝
//   · 渲染层 src/lib/agent-bridge.js：动作前先 agentGrant()，拿到允许再发真正请求
//   · src/agent/authorization.js：仍然负责 UI 语义（范围/TTL/撤销/批量审批的展示），
//     它和这里的风险等级表一致；但**要不要真的放行**由主进程用本文件再判一次
//
// 纯 JS，不 import 任何 node: 内置模块（渲染层要能直接 import）。
// ============================================================

/** 能力（= 主进程真正执行的动作类别）。审计与授权都按这个粒度记。 */
const CAPABILITY = {
  FS_READ: 'fs.read',
  FS_WRITE: 'fs.write',
  FS_COPY: 'fs.copy',
  FS_MOVE: 'fs.move',
  FS_DELETE: 'fs.delete',
  EXEC: 'exec.run',
  GIT_READ: 'git.read',
  GIT_COMMIT: 'git.commit',
  SCREEN_CAPTURE: 'screen.capture',
  WINDOW_READ: 'window.read',
  WINDOW_CONTROL: 'window.control',
  APP_LAUNCH: 'app.launch',
  APP_CONTROL: 'app.control',
  INPUT_POINTER: 'input.pointer',
  INPUT_KEYBOARD: 'input.keyboard',
  // UIA：读控件树是「看屏幕」的语义（LOW）；按控件执行动作是「操作电脑」（HIGH）
  UIA_READ: 'desktop.uia.read',
  UIA_ACT: 'desktop.uia.act',
  // 网页抓取：只读公网（LOW），但出口有 SSRF 防护与体积上限
  WEB_FETCH: 'web.fetch',
};

const RISK = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', CRITICAL: 'CRITICAL' };
const RISK_ORDER = [RISK.LOW, RISK.MEDIUM, RISK.HIGH, RISK.CRITICAL];

/** 能力 → 风险。读类 LOW；改磁盘/提交 MEDIUM；动手改电脑状态 HIGH。 */
const CAP_RISK = {
  [CAPABILITY.FS_READ]: RISK.LOW,
  [CAPABILITY.GIT_READ]: RISK.LOW,
  [CAPABILITY.SCREEN_CAPTURE]: RISK.LOW,
  [CAPABILITY.WINDOW_READ]: RISK.LOW,
  [CAPABILITY.UIA_READ]: RISK.LOW,
  [CAPABILITY.FS_WRITE]: RISK.MEDIUM,
  [CAPABILITY.FS_COPY]: RISK.MEDIUM,
  [CAPABILITY.FS_MOVE]: RISK.MEDIUM,
  [CAPABILITY.GIT_COMMIT]: RISK.MEDIUM,
  [CAPABILITY.FS_DELETE]: RISK.HIGH,
  [CAPABILITY.EXEC]: RISK.HIGH,
  [CAPABILITY.WINDOW_CONTROL]: RISK.HIGH,
  [CAPABILITY.APP_LAUNCH]: RISK.HIGH,
  [CAPABILITY.APP_CONTROL]: RISK.HIGH,
  [CAPABILITY.INPUT_POINTER]: RISK.HIGH,
  [CAPABILITY.INPUT_KEYBOARD]: RISK.HIGH,
  [CAPABILITY.UIA_ACT]: RISK.HIGH,
  [CAPABILITY.WEB_FETCH]: RISK.LOW,
};

/** 需要「批准过才能做」的能力（LOW 不必走凭证，省 IPC）。 */
const ACTION_CAPABILITIES = [
  CAPABILITY.FS_WRITE,
  CAPABILITY.FS_COPY,
  CAPABILITY.FS_MOVE,
  CAPABILITY.FS_DELETE,
  CAPABILITY.GIT_COMMIT,
  CAPABILITY.EXEC,
  CAPABILITY.WINDOW_CONTROL,
  CAPABILITY.APP_LAUNCH,
  CAPABILITY.APP_CONTROL,
  CAPABILITY.INPUT_POINTER,
  CAPABILITY.INPUT_KEYBOARD,
  CAPABILITY.UIA_ACT,
];

const AUTH_MODE = { MANUAL: 'manual', BATCH: 'batch', TRUST: 'trust' };

function isRisk(level) {
  return RISK_ORDER.indexOf(String(level)) >= 0;
}

function riskOf(capability) {
  return CAP_RISK[String(capability)] || RISK.HIGH;
}

function isActionCapability(capability) {
  return ACTION_CAPABILITIES.includes(String(capability));
}

/**
 * 授权配置归一化（只认这几个键，别的丢掉）。
 * 与 shared/util.cjs 的 normalizeAuthorizationCfg 保持同一套字段。
 */
function normalizeCfg(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const mode = Object.values(AUTH_MODE).includes(r.mode) ? r.mode : AUTH_MODE.MANUAL;
  return {
    mode,
    scope: r.scope === 'persistent' ? 'persistent' : 'task',
    allowHighRisk: r.allowHighRisk === true,
    fullAccess: r.fullAccess === true,
    expiresAt: Number.isFinite(r.expiresAt) ? r.expiresAt : null,
    revokedAt: Number.isFinite(r.revokedAt) ? r.revokedAt : null,
  };
}

/**
 * 策略判定（**不看渲染层说了什么**，只看设置）。
 *
 * 注意这里和「UI 上要不要弹卡片」是两件事：
 *   · 渲染层弹卡 = 用户体验；用户点「批准」后仍要来主进程要凭证
 *   · 这里回答「按当前设置，这个能力能不能不经批准就做」
 *
 * @returns {{decision:'allow'|'ask'|'deny', reason:string, risk:string}}
 */
function decide({ capability, risk, cfg, requireMedium = true, now = Date.now() } = {}) {
  const c = normalizeCfg(cfg);
  const level = isRisk(risk) ? risk : riskOf(capability);
  const out = (decision, reason) => ({ decision, reason, risk: level, capability: capability || '' });

  if (c.revokedAt) return out('deny', 'authorization-revoked');
  if (c.expiresAt && now >= c.expiresAt) return out('deny', 'authorization-expired');
  // CRITICAL 排在完整权限之前：即使打开「完整权限」，CRITICAL 也要单独确认
  // （任务书 3.3：完全信任不能把 HIGH/CRITICAL 自动降级）
  if (level === RISK.CRITICAL) return out('ask', 'critical-risk');
  if (c.fullAccess) return out('allow', 'full-access');
  if (level === RISK.LOW) return out('allow', 'low-risk');
  if (level === RISK.MEDIUM) {
    // 手动模式 + requireMedium 才逐次问；批处理/信任模式视为已授权
    if (c.mode === AUTH_MODE.MANUAL && requireMedium) return out('ask', 'medium-needs-approval');
    return out('allow', 'medium-allowed-by-mode');
  }
  // HIGH：只有「信任 + 明确允许高风险」才自动执行
  if (c.mode === AUTH_MODE.TRUST && c.allowHighRisk) return out('allow', 'trust-high-risk');
  return out('ask', 'high-needs-approval');
}

// ------------------------------------------------------------
// 参数投影与哈希
//
// 凭证必须绑定「这一次具体要做什么」：批准了写 A 文件，不能拿去写 B 文件；
// 批准了跑 npm test，不能拿去跑别的命令。
// ------------------------------------------------------------

/** 把一个通道 payload 投影成「这次动作的身份」（只取决定安全性的字段） */
function projection(capability, payload) {
  const p = (payload && typeof payload === 'object') ? payload : {};
  switch (String(capability)) {
    case CAPABILITY.FS_WRITE:
      return { op: String(p.op || 'write'), path: String(p.path || '') };
    case CAPABILITY.FS_COPY:
    case CAPABILITY.FS_MOVE:
      return { op: String(p.op || ''), from: String(p.path || ''), to: String(p.to || '') };
    case CAPABILITY.FS_DELETE:
      return { op: String(p.op || 'remove'), path: String(p.path || ''), permanent: p.permanent === true };
    case CAPABILITY.UIA_ACT:
      return {
        op: String(p.op || ''),
        action: String(p.action || ''),
        selector: p.selector && typeof p.selector === 'object' ? stableStringify(p.selector) : '',
        value: String(p.value == null ? '' : p.value).slice(0, 400),
      };
    case CAPABILITY.FS_READ:
      return { op: String(p.op || ''), path: String(p.path || '') };
    case CAPABILITY.EXEC:
      return { command: String(p.command || ''), args: Array.isArray(p.args) ? p.args.map((a) => String(a)) : [] };
    case CAPABILITY.GIT_COMMIT:
      return { args: Array.isArray(p.args) ? p.args.map((a) => String(a)) : [] };
    case CAPABILITY.GIT_READ:
      return { args: Array.isArray(p.args) ? p.args.map((a) => String(a)) : [] };
    case CAPABILITY.WINDOW_CONTROL:
      return { op: String(p.op || ''), title: String(p.title || '') };
    case CAPABILITY.WINDOW_READ:
      return { op: String(p.op || 'list') };
    case CAPABILITY.UIA_READ:
      return { op: String(p.op || 'tree'), window: String(p.window || '') };
    case CAPABILITY.APP_CONTROL:
      return { op: String(p.op || ''), target: String(p.target || '') };
    case CAPABILITY.APP_LAUNCH:
      return { target: String(p.target || '') };
    case CAPABILITY.INPUT_POINTER:
      return {
        op: String(p.op || ''),
        x: Number.isFinite(p.x) ? Math.round(p.x) : null,
        y: Number.isFinite(p.y) ? Math.round(p.y) : null,
        toX: Number.isFinite(p.toX) ? Math.round(p.toX) : null,
        toY: Number.isFinite(p.toY) ? Math.round(p.toY) : null,
        direction: String(p.direction || ''),
        amount: Number.isFinite(Number(p.amount)) ? Math.round(Number(p.amount)) : null,
        button: String(p.button || ''),
        double: p.double === true,
      };
    case CAPABILITY.INPUT_KEYBOARD:
      return {
        op: String(p.op || ''),
        text: String(p.text == null ? '' : p.text),
        keys: Array.isArray(p.keys) ? p.keys.map((k) => String(k)) : [],
      };
    case CAPABILITY.SCREEN_CAPTURE:
      return { withData: p.withData === true };
    case CAPABILITY.WEB_FETCH:
      return { url: String(p.url || '') };
    default:
      return {};
  }
}

/** 稳定序列化：键排序，避免同一个动作算出两个哈希 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/** 32 位 FNV-1a（够用来做凭证绑定，不需要密码学强度） */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

function argsHash(capability, payload) {
  return fnv1a(String(capability) + '|' + stableStringify(projection(capability, payload)));
}

/**
 * 一次性凭证表。
 * 凭证只对「同一能力 + 同一参数投影」有效，用完即删，过期即删。
 */
function createGrants({ ttlMs = 120000, max = 128, now = Date.now } = {}) {
  const items = new Map();
  const clock = typeof now === 'function' ? now : () => Date.now();

  function sweep() {
    const t = clock();
    for (const [key, g] of items) {
      if (!g || t >= g.expiresAt) items.delete(key);
    }
    while (items.size > max) {
      const oldest = items.keys().next();
      if (oldest.done) break;
      items.delete(oldest.value);
    }
  }

  function keyOf(capability, hash) {
    return String(capability) + '#' + String(hash);
  }

  return {
    /** 记账：批准一次动作 */
    issue({ capability, argsHash: hash }) {
      sweep();
      const key = keyOf(capability, hash);
      items.set(key, { capability: String(capability), hash: String(hash), expiresAt: clock() + ttlMs });
      return { ok: true, expiresAt: clock() + ttlMs };
    },
    /** 核销：这个动作确实被批准过（一次性，核销后失效） */
    consume({ capability, argsHash: hash }) {
      sweep();
      const key = keyOf(capability, hash);
      if (!items.has(key)) return false;
      items.delete(key);
      return true;
    },
    size() { sweep(); return items.size; },
    clear() { items.clear(); },
  };
}

/** 审计用的一行摘要：只放「目标」，绝不放文件正文 / 剪贴板内容 / 密钥 */
function summarize(capability, payload, limit = 200) {
  const p = (payload && typeof payload === 'object') ? payload : {};
  let text = '';
  switch (String(capability)) {
    case CAPABILITY.FS_WRITE:
    case CAPABILITY.FS_READ:
      text = String(p.op || '') + ' ' + String(p.path || '');
      break;
    case CAPABILITY.FS_COPY:
    case CAPABILITY.FS_MOVE:
      text = String(p.op || '') + ' ' + String(p.path || '') + ' → ' + String(p.to || '');
      break;
    case CAPABILITY.FS_DELETE:
      text = 'remove ' + String(p.path || '') + (p.permanent === true ? '（永久）' : '（回收站）');
      break;
    case CAPABILITY.UIA_READ:
      text = 'uia tree ' + String(p.window || '');
      break;
    case CAPABILITY.UIA_ACT:
      text = 'uia ' + String(p.action || p.op || '') + ' ' + (p.selector ? JSON.stringify(p.selector).slice(0, 120) : '');
      break;
    case CAPABILITY.APP_CONTROL:
      text = String(p.op || '') + ' ' + String(p.target || '');
      break;
    case CAPABILITY.EXEC:
      text = [String(p.command || '')].concat((Array.isArray(p.args) ? p.args : []).map((a) => String(a))).join(' ');
      break;
    case CAPABILITY.GIT_READ:
    case CAPABILITY.GIT_COMMIT:
      text = 'git ' + (Array.isArray(p.args) ? p.args.join(' ') : '');
      break;
    case CAPABILITY.WINDOW_READ:
    case CAPABILITY.WINDOW_CONTROL:
      text = String(p.op || '') + ' ' + String(p.title || '');
      break;
    case CAPABILITY.APP_LAUNCH:
      text = String(p.target || '');
      break;
    case CAPABILITY.INPUT_POINTER:
      text = String(p.op || '') + ' ' + (Number.isFinite(p.x) ? p.x + ',' + p.y : String(p.button || ''));
      break;
    case CAPABILITY.INPUT_KEYBOARD:
      // 打字内容可能是密码：只记长度，不记原文
      text = String(p.op || '') + ' (' + (p.text ? String(p.text).length + ' chars' : (Array.isArray(p.keys) ? p.keys.join('+') : '')) + ')';
      break;
    case CAPABILITY.SCREEN_CAPTURE:
      text = p.withData ? 'with data' : 'size only';
      break;
    case CAPABILITY.WEB_FETCH:
      text = 'GET ' + String(p.url || '');
      break;
    default:
      text = '';
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

module.exports = {
  CAPABILITY,
  ACTION_CAPABILITIES,
  CAP_RISK,
  RISK,
  RISK_ORDER,
  AUTH_MODE,
  isRisk,
  riskOf,
  isActionCapability,
  normalizeCfg,
  decide,
  projection,
  stableStringify,
  fnv1a,
  argsHash,
  createGrants,
  summarize,
};

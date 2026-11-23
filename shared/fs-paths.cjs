'use strict';
// ============================================================
// Agent 文件系统路径解析（唯一一份）
//
// 为什么单独一个模块：以前渲染层 executor 有自己的边界判断（`resolveInsideWorkspace`），
// 主进程 `agent-ipc.cjs` 又有一份 `resolveSafe`，两边的规则、报错文案、对 `~` 与
// 盘符相对路径的处理全都不一样 —— 模型看到的是「这里能写、那里不能写」的随机行为。
//
// 现在的约定：
//   · **工作区只是默认工作目录，不是唯一的可访问边界。**
//     工作区外的普通目录属于「外部文件访问」，需要授权（见 permission / authz）。
//   · 敏感路径（凭据、密钥、AILEEN 自己的设置与数据）永远拒绝，完整权限也不能碰。
//   · 纯 JS，不 require 任何 node: 内置模块 —— 渲染层（浏览器 bundle）与主进程共用同一份。
//   · Windows 路径**不能套 POSIX 规则**：盘符、`\`、大小写不敏感、盘符相对路径（`C:x`）、
//     设备命名空间（`\\?\`）、NTFS 数据流（`file.txt:stream`）都在这里显式处理。
//
// 符号链接 / junction / reparse point 的越界由主进程用 realpath 兜底（本模块只做纯字符串
// 解析，拿不到真实文件系统）。
// ============================================================

const pathUtil = require('./path-util.cjs');

const { toSlash, normalize, resolve, join, isInside, isAbsolute, dirname, basename } = pathUtil;

/** 错误码：界面与模型都能据此区分「越界 / 未授权 / 敏感 / 同名 / 在自身里」 */
const CODE = {
  INVALID_PATH: 'INVALID_PATH',
  EXTERNAL_ACCESS_REQUIRED: 'EXTERNAL_ACCESS_REQUIRED',
  SENSITIVE_PATH: 'SENSITIVE_PATH',
  SAME_PATH: 'SAME_PATH',
  TARGET_INSIDE_SOURCE: 'TARGET_INSIDE_SOURCE',
  HOME_UNKNOWN: 'HOME_UNKNOWN',
  NO_WORKSPACE: 'NO_WORKSPACE',
};

/**
 * 敏感路径模板（不管在哪个工作区、有没有完整权限，一律拒绝）。
 *
 * 注意这里**故意保持保守**：`settings.json` 这种名字在全世界到处都有，但 AILEEN 自己的设置
 * 文件里有 API Key，而 `<userData>` 这种「只有本机才知道的根」由 protectedRoots 传进来。
 * 宁可多拦一个，也不要漏掉密钥。
 */
const SENSITIVE_PATTERNS = [
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.gnupg([\\/]|$)/i,
  /(^|[\\/])\.git-credentials$/i,
  /(^|[\\/])\.git[\\/]config$/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /(^|[\\/])\.p12$|(^|[\\/])\.pfx$/i,
  /(^|[\\/])(Login Data|Cookies|Web Data)$/i,
  /(^|[\\/])(Google[\\/]Chrome|Microsoft[\\/]Edge|BraveSoftware|Mozilla[\\/]Firefox)/i,
  /(^|[\\/])settings\.json$/i,
  /(^|[\\/])secrets[^\\/]*\.json$/i,
  /(^|[\\/])\.credentials\.yaml$/i,
  /(^|[\\/])Windows[\\/]System32/i,
  /(^|[\\/])(WinSxS|System Volume Information|\$Recycle\.Bin)([\\/]|$)/i,
  /(^|[\\/])(SAM|SECURITY|SYSTEM|NTUSER\.DAT|pagefile\.sys|hiberfil\.sys)$/i,
];

function makeError(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
}

function lowerPath(p) {
  const s = toSlash(normalize(p));
  return onWindows() ? s.toLowerCase() : s;
}

/** 运行环境是不是 Windows（浏览器里没有 process，按「是」处理：这个应用只发 Windows 版） */
function onWindows() {
  try {
    if (typeof process !== 'undefined' && process.platform) return process.platform === 'win32';
  } catch { /* 浏览器 */ }
  return true;
}

/** 设备命名空间 / 盘符相对 / NTFS 数据流：这些「看起来像路径」的东西必须直接拒绝 */
function inspectRaw(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  if (s.includes('\0')) return { code: CODE.INVALID_PATH, message: '路径里有非法字符（NUL）' };
  if (/^\\\\[.?]\\/.test(s)) {
    return { code: CODE.INVALID_PATH, message: '不支持设备命名空间路径（\\\\?\\ / \\\\.\\）：' + s };
  }
  // Windows 盘符相对路径（C:foo）含义随「当前目录」变化，静默解析一定是错的
  if (/^[a-zA-Z]:(?![\\/])/.test(s)) {
    return { code: CODE.INVALID_PATH, message: '盘符相对路径不明确（' + s + '），请写成 C:\\完整\\路径 或相对工作区的路径' };
  }
  // NTFS 交替数据流：C:\x\a.txt:hidden —— 会绕过「按文件名」的判断
  const noDrive = s.replace(/^[a-zA-Z]:/, '');
  if (noDrive.includes(':')) {
    return { code: CODE.INVALID_PATH, message: '路径里出现了多余的冒号（NTFS 数据流或非法名字）：' + s };
  }
  if (/[<>"|?*]/.test(noDrive)) {
    return { code: CODE.INVALID_PATH, message: '路径里有 Windows 不允许的字符（< > " | ? *）：' + s };
  }
  return null;
}

/**
 * 把模型给的路径解析成绝对路径。**只做解析，不做权限判断**。
 * @param {string} target
 * @param {{workspace?:string, home?:string}} opts
 * @returns {{ok:true, raw:string, abs:string}|{ok:false, error:{code:string,message:string}}}
 */
function resolveAgentPath(target, opts = {}) {
  const workspace = String(opts.workspace || '').trim();
  const home = String(opts.home || '').trim();
  const raw = target == null ? '' : String(target);
  const bad = inspectRaw(raw);
  if (bad) return { ok: false, error: bad };

  let text = raw.trim() || '.';
  // `~` 必须显式展开；拿不到 home 就报错，**绝不**静默当成相对路径（那会跑到工作区里造一个 `~` 目录）
  if (text === '~' || /^~[\\/]/.test(text)) {
    if (!home) {
      return { ok: false, error: { code: CODE.HOME_UNKNOWN, message: '无法确定用户主目录，用不了 ~，请写完整绝对路径' } };
    }
    text = text === '~' ? home : join(home, text.slice(2));
  }
  if (!isAbsolute(text)) {
    if (!workspace) {
      return { ok: false, error: { code: CODE.NO_WORKSPACE, message: '还没有绑定工作区，相对路径无从解析' } };
    }
    return { ok: true, raw, abs: resolve(workspace, text) };
  }
  return { ok: true, raw, abs: normalize(text) };
}

/** 这个绝对路径在工作区内还是外部 */
function scopeOf(abs, workspace) {
  if (!workspace) return 'external';
  return isInside(abs, workspace) ? 'workspace' : 'external';
}

/**
 * 敏感判断。
 * @param {string} abs
 * @param {{protectedRoots?:string[]}} [opts] protectedRoots：本机私有根（AILEEN 数据目录、设置文件…）
 */
function isSensitivePath(abs, opts = {}) {
  const p = String(abs == null ? '' : abs);
  if (!p) return false;
  for (const root of (opts.protectedRoots || [])) {
    if (root && isInside(p, root)) return true;
  }
  const s = toSlash(normalize(p));
  for (const re of SENSITIVE_PATTERNS) if (re.test(s)) return true;
  return false;
}

/**
 * 解析 + 权限范围校验。
 * @param {object} params
 *   target            用户/模型给的路径
 *   workspace         工作区绝对路径
 *   home              用户主目录（用于 ~）
 *   allowExternal     是否已获得「外部文件访问」授权
 *   protectedRoots    敏感根
 * @returns {{ok:true, raw, abs, scope:'workspace'|'external'}|{ok:false, error}}
 */
function validateAgentPath({ target, workspace, home, allowExternal = false, protectedRoots = [] } = {}) {
  const r = resolveAgentPath(target, { workspace, home });
  if (!r.ok) return r;
  if (isSensitivePath(r.abs, { protectedRoots })) {
    return {
      ok: false,
      error: {
        code: CODE.SENSITIVE_PATH,
        message: '该路径属于敏感区域（凭据 / 密钥 / 设置 / 系统保护目录），Agent 不允许访问：' + r.raw,
      },
    };
  }
  const scope = scopeOf(r.abs, workspace);
  if (scope === 'external' && !allowExternal) {
    return {
      ok: false,
      error: {
        code: CODE.EXTERNAL_ACCESS_REQUIRED,
        message: '路径在工作区之外，需要「外部文件访问」授权：' + r.raw
          + '（当前工作区 ' + workspace + '；批准这次操作，或在 Agent 权限里打开信任模式 / 完整权限）',
      },
    };
  }
  return { ok: true, raw: r.raw, abs: r.abs, scope };
}

/** 两个绝对路径是不是同一个（Windows 大小写不敏感） */
function samePath(a, b) {
  return lowerPath(a) === lowerPath(b);
}

function shapeMoveLike({ from, to, workspace, home, allowExternal, protectedRoots }) {
  const a = validateAgentPath({ target: from, workspace, home, allowExternal, protectedRoots });
  if (!a.ok) return Object.assign({ ok: false }, a.error ? { error: a.error } : {});
  const b = validateAgentPath({ target: to, workspace, home, allowExternal, protectedRoots });
  if (!b.ok) return Object.assign({ ok: false }, b.error ? { error: b.error } : {});
  if (samePath(a.abs, b.abs)) {
    return { ok: false, error: { code: CODE.SAME_PATH, message: '源路径和目标路径是同一个：' + a.raw } };
  }
  if (isInside(b.abs, a.abs)) {
    return {
      ok: false,
      error: {
        code: CODE.TARGET_INSIDE_SOURCE,
        message: '目标路径在源路径内部（' + b.raw + ' 在 ' + a.raw + ' 里面），移动/复制会无限嵌套',
      },
    };
  }
  // 不许把工作区根本身搬走/复制走
  if (workspace && samePath(a.abs, workspace)) {
    return { ok: false, error: { code: CODE.INVALID_PATH, message: '不能移动或复制工作区根目录本身' } };
  }
  const scope = (a.scope === 'external' || b.scope === 'external') ? 'external' : 'workspace';
  return {
    ok: true,
    from: a.abs,
    to: b.abs,
    fromScope: a.scope,
    toScope: b.scope,
    scope,
    crossScope: a.scope !== b.scope,
  };
}

/** 移动校验（from/to 两边都要过范围与敏感名单，且不能把目录搬进自己里面） */
function validateMoveOperation(params = {}) {
  return shapeMoveLike(params);
}

/** 复制校验（规则与移动一致：目标在源内部一样会无限嵌套） */
function validateCopyOperation(params = {}) {
  return shapeMoveLike(params);
}

/**
 * 从工具参数里挑出「会碰到文件系统的路径」，给授权层用于判断要不要升级风险。
 * @returns {Array<{key:string, raw:string, abs:string|null, scope:string}>}
 */
function externalTargets(args, { workspace, home } = {}) {
  const a = (args && typeof args === 'object') ? args : {};
  const keys = ['path', 'to', 'from', 'cwd'];
  const out = [];
  for (const key of keys) {
    const raw = a[key];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const r = resolveAgentPath(raw, { workspace, home });
    if (!r.ok) continue;
    out.push({ key, raw, abs: r.abs, scope: scopeOf(r.abs, workspace) });
  }
  return out;
}

/** 给人看的一句话：工作区内的用相对路径，外部用完整路径，家目录下用 ~ */
function describePath(abs, { workspace, home } = {}) {
  const p = String(abs == null ? '' : abs);
  if (!p) return '';
  if (workspace && isInside(p, workspace)) {
    const rel = pathUtil.relative(workspace, p);
    return '工作区/' + (rel || '.');
  }
  if (home && isInside(p, home)) {
    const rel = pathUtil.relative(home, p);
    return '~/' + (rel || '.');
  }
  return pathUtil.toNative(p);
}

module.exports = {
  CODE,
  SENSITIVE_PATTERNS,
  DIRNAME: dirname,
  BASENAME: basename,
  inspectRaw,
  resolveAgentPath,
  scopeOf,
  isSensitivePath,
  validateAgentPath,
  validateMoveOperation,
  validateCopyOperation,
  externalTargets,
  describePath,
  samePath,
  makeError,
};

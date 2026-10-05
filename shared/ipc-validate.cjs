'use strict';
// ============================================================
// Renderer → Main 的 IPC 参数验证
//
// 原则：**不信任渲染层**。
// 渲染层是网页环境：任何被注入的脚本、被加载的第三方页面、将来多开的一个
// webContents，都能用同样的 API 调这些 handle。发送方鉴权（ipc-guard）只解决
// 「是谁在调」，这里解决「调的时候给了什么」。
//
// 用法（声明式，每个通道一行）：
//   const schema = v.object({ file: v.fileName({ max: 128 }), messages: v.array(v.msg(), { max: 5000 }) })
//   schema.check(args)              // 不通过就抛带字段名的错
//
// 设计约束：
//   · **纯函数、零依赖** —— 主进程与单测共用；
//   · 不通过时**抛错**，不静默改值（静默会把「喂了错参数」变成「行为怪但不说」）；
//   · 只做类型/范围/形状校验，**不做业务语义**（业务判断留给各自的 handler）。
// ============================================================

/** 校验失败：带上字段路径，便于定位是哪个参数有问题 */
class ValidationError extends Error {
  constructor(field, message) {
    super('IPC 参数无效：' + field + ' —— ' + message);
    this.name = 'ValidationError';
    this.field = field;
    this.code = 'BAD_IPC_ARG';
  }
}

const fail = (field, msg) => { throw new ValidationError(field, msg); };

// ------------------------------------------------------------
// 基础原语
// ------------------------------------------------------------

/** 字符串（可限长、可要求非空） */
function str({ max = 1000, min = 0, allowEmpty = true, trim = false } = {}) {
  return {
    kind: 'string',
    parse(v, field) {
      if (typeof v !== 'string') fail(field, '应为字符串，收到 ' + typeof v);
      const s = trim ? v.trim() : v;
      if (!allowEmpty && s.length === 0) fail(field, '不能为空');
      if (s.length < min) fail(field, '太短（至少 ' + min + ' 字符）');
      if (s.length > max) fail(field, '太长（最多 ' + max + ' 字符，实际 ' + s.length + '）');
      return s;
    },
  };
}

/** 布尔 */
function bool({ dflt } = {}) {
  return {
    kind: 'boolean',
    parse(v, field) {
      if (v === undefined && dflt !== undefined) return dflt;
      if (typeof v !== 'boolean') fail(field, '应为布尔值，收到 ' + typeof v);
      return v;
    },
  };
}

/** 整数（可限范围） */
function int({ min = -Infinity, max = Infinity, dflt } = {}) {
  return {
    kind: 'integer',
    parse(v, field) {
      if (v === undefined && dflt !== undefined) return dflt;
      if (typeof v !== 'number' || !Number.isInteger(v)) fail(field, '应为整数，收到 ' + JSON.stringify(v));
      if (v < min || v > max) fail(field, '超出范围 [' + min + ', ' + max + ']：' + v);
      return v;
    },
  };
}

/** 数字（可限范围；接受能转成数字的字符串） */
function num({ min = -Infinity, max = Infinity, dflt } = {}) {
  return {
    kind: 'number',
    parse(v, field) {
      if (v === undefined && dflt !== undefined) return dflt;
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) fail(field, '应为数字，收到 ' + JSON.stringify(v));
      if (n < min || n > max) fail(field, '超出范围 [' + min + ', ' + max + ']：' + n);
      return n;
    },
  };
}

/** 枚举 */
function oneOf(list, { dflt } = {}) {
  return {
    kind: 'enum',
    parse(v, field) {
      if (v === undefined && dflt !== undefined) return dflt;
      if (!list.includes(v)) fail(field, '只能是 ' + list.join(' / ') + '，收到 ' + JSON.stringify(v));
      return v;
    },
  };
}

/** 数组（限长；元素可用子校验器） */
function arr(item, { max = 1000 } = {}) {
  return {
    kind: 'array',
    parse(v, field) {
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v)) fail(field, '应为数组，收到 ' + typeof v);
      if (v.length > max) fail(field, '元素太多（最多 ' + max + '，实际 ' + v.length + '）');
      if (!item) return v;
      return v.map((x, i) => item.parse(x, field + '[' + i + ']'));
    },
  };
}

/** 对象（字段级校验；未知字段默认丢弃） */
function object(shape, { allowUnknown = false } = {}) {
  return {
    kind: 'object',
    parse(v, field) {
      if (v === undefined || v === null) v = {};
      if (typeof v !== 'object' || Array.isArray(v)) fail(field, '应为对象，收到 ' + typeof v);
      const out = {};
      for (const [key, spec] of Object.entries(shape)) {
        const raw = v[key];
        if (raw === undefined) {
          if (spec.kind === 'optional') continue;
          // 未提供且没有默认值 → 交给 spec 自己决定（多数会因类型不符而报错）
          out[key] = spec.parse(undefined, field + '.' + key);
          continue;
        }
        out[key] = spec.parse(raw, field + '.' + key);
      }
      if (allowUnknown) {
        for (const [key, raw] of Object.entries(v)) {
          if (!(key in shape)) out[key] = raw;
        }
      }
      return out;
    },
  };
}

/** 可选（缺省时给 undefined，不触发子校验） */
function optional(spec) {
  return {
    kind: 'optional',
    parse(v, field) {
      if (v === undefined || v === null) return undefined;
      return spec.parse(v, field);
    },
  };
}

/** 任意值（仍会挡掉函数/符号这类不可序列化的东西） */
function any() {
  return {
    kind: 'any',
    parse(v) {
      const t = typeof v;
      if (t === 'function' || t === 'symbol' || t === 'bigint') fail('value', '类型不可序列化：' + t);
      return v;
    },
  };
}

// ------------------------------------------------------------
// 语义原语（这一层才是真正防注入的地方）
// ------------------------------------------------------------

/** 裸文件名：不允许任何路径分隔符或 ..（角色卡、聊天记录都用它） */
function fileName({ max = 128, ext } = {}) {
  return {
    kind: 'fileName',
    parse(v, field) {
      if (typeof v !== 'string') fail(field, '应为字符串');
      const s = v.trim();
      if (!s) fail(field, '不能为空');
      if (s.length > max) fail(field, '文件名太长（最多 ' + max + '）');
      if (/[\\/]/.test(s)) fail(field, '文件名里不能有路径分隔符');
      if (s.includes('..')) fail(field, '文件名里不能有 ..');
      if (/[\0<>:"|?*]/.test(s)) fail(field, '文件名含非法字符');
      if (ext && !s.toLowerCase().endsWith(ext)) fail(field, '文件名必须以 ' + ext + ' 结尾');
      return s;
    },
  };
}

/** http(s) 链接 */
function url({ max = 1000 } = {}) {
  return {
    kind: 'url',
    parse(v, field) {
      if (typeof v !== 'string') fail(field, '应为字符串');
      const s = v.trim();
      if (!s) fail(field, '不能为空');
      if (s.length > max) fail(field, 'URL 太长');
      let u;
      try { u = new URL(s); } catch { fail(field, '不是合法 URL'); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') fail(field, '只允许 http/https，收到 ' + u.protocol);
      return s;
    },
  };
}

/** 绝对路径（只做「长得像路径」的校验，真正的边界校验在调用方） */
function absPath({ max = 1000 } = {}) {
  return {
    kind: 'path',
    parse(v, field) {
      if (typeof v !== 'string') fail(field, '应为字符串');
      const s = v.trim();
      if (!s) fail(field, '不能为空');
      if (s.length > max) fail(field, '路径太长');
      if (s.includes('\0')) fail(field, '路径含空字符');
      const isWin = /^[a-zA-Z]:[\\/]/.test(s);
      const isUnc = /^\\\\[^\\]/.test(s);
      const isPosix = s.startsWith('/');
      if (!isWin && !isUnc && !isPosix) fail(field, '必须是绝对路径：' + s);
      return s;
    },
  };
}

/** 屏幕/窗口尺寸 */
function dimension({ min = 1, max = 20000 } = {}) {
  return int({ min, max });
}

/** 颜色 #rrggbb */
function hexColor() {
  return {
    kind: 'hex',
    parse(v, field) {
      if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) fail(field, '应为 #rrggbb 颜色，收到 ' + JSON.stringify(v));
      return v;
    },
  };
}

/** 一条聊天消息 { role, content } */
function message() {
  return object({
    role: oneOf(['user', 'assistant', 'system', 'tool']),
    content: any(),
  }, { allowUnknown: true });
}

/** 按键名（Minecraft 控制 / 键盘用） */
function keyName() {
  return {
    kind: 'key',
    parse(v, field) {
      if (typeof v !== 'string') fail(field, '应为字符串');
      if (!/^[a-zA-Z0-9_]{1,32}$/.test(v)) fail(field, '按键名不合法：' + v);
      return v;
    },
  };
}

/** 一个可执行程序名/命令名（不含路径分隔符与元字符） */
function commandName() {
  return {
    kind: 'command',
    parse(v, field) {
      if (typeof v !== 'string') fail(field, '应为字符串');
      const s = v.trim();
      if (!s) fail(field, '不能为空');
      if (/[\\/]/.test(s)) fail(field, '程序名里不能有路径');
      if (/[;&|`$><\r\n\0]/.test(s)) fail(field, '程序名含 shell 元字符');
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(s)) fail(field, '程序名不合法：' + s);
      return s;
    },
  };
}

// ------------------------------------------------------------
// 组合
// ------------------------------------------------------------

/**
 * 把「参数数组」按位置声明式校验。
 * 主进程的 handle 收到的是 (event, ...args)，注册时把 args 位置写清楚即可。
 *
 * **多传参数也算非法**：通道声明了几个参数就是几个 ——
 * 多出来的东西要么是调用方写错了，要么是有人想往主进程塞 payload，
 * 两种都该当场报错，而不是静默丢掉。
 */
function args(...specs) {
  return {
    parse(argList, channel) {
      const list = Array.isArray(argList) ? argList : [];
      if (list.length > specs.length) {
        fail(channel, '这个通道只接受 ' + specs.length + ' 个参数，收到 ' + list.length + ' 个');
      }
      return specs.map((spec, i) => spec.parse(list[i], channel + '[' + i + ']'));
    },
  };
}

/** 没有任何参数 */
const NO_ARGS = args();

module.exports = {
  ValidationError,
  str, bool, int, num, oneOf, arr, object, optional, any,
  fileName, url, absPath, dimension, hexColor, message, keyName, commandName,
  args, NO_ARGS,
};

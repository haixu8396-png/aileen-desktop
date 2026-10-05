// ============================================================
// 工具注册表
//
// 每个工具的形状是固定的：
//   { name, description, inputSchema, riskLevel, execute() }
//
// 注册时就校验形状 —— 少了 inputSchema 或 execute 的工具不许进表，
// 否则等到模型真调它的时候才炸，排查成本高得多。
// ============================================================
import { riskForTool, isRiskLevel, RISK } from './permission.js';

/** 支持的 JSON Schema 子集（provider 的 function calling 只需要这些） */
const ALLOWED_TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object'];

function checkSchema(schema, where) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(where + ' 的 inputSchema 必须是对象');
  }
  if (schema.type !== 'object') {
    throw new Error(where + ' 的 inputSchema.type 必须是 "object"');
  }
  const props = schema.properties === undefined ? {} : schema.properties;
  if (typeof props !== 'object' || Array.isArray(props)) {
    throw new Error(where + ' 的 inputSchema.properties 必须是对象');
  }
  for (const [key, spec] of Object.entries(props)) {
    if (!spec || typeof spec !== 'object') throw new Error(where + ' 的字段 ' + key + ' 缺少类型声明');
    if (!ALLOWED_TYPES.includes(spec.type)) {
      throw new Error(where + ' 的字段 ' + key + ' 类型不支持：' + String(spec.type));
    }
    if (spec.type === 'array' && spec.items && !ALLOWED_TYPES.includes(spec.items.type)) {
      throw new Error(where + ' 的字段 ' + key + ' 数组元素类型不支持');
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) throw new Error(where + ' 的 required 必须是数组');
    for (const key of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) {
        throw new Error(where + ' 的 required 里出现了未声明的字段：' + key);
      }
    }
  }
  return true;
}

/** 校验一个工具定义，返回规范化后的副本 */
export function defineTool(spec) {
  const s = spec && typeof spec === 'object' ? spec : {};
  const name = String(s.name || '').trim();
  if (!/^[a-z][a-z0-9_]{1,48}$/.test(name)) {
    throw new Error('工具名不合法（小写字母开头 + 下划线，2~49 字符）：' + name);
  }
  const description = String(s.description || '').trim();
  if (!description) throw new Error('工具 ' + name + ' 缺少 description（模型靠它决定用不用）');
  checkSchema(s.inputSchema, '工具 ' + name);
  if (typeof s.execute !== 'function') throw new Error('工具 ' + name + ' 缺少 execute()');
  const riskLevel = isRiskLevel(s.riskLevel) ? s.riskLevel : riskForTool({ name });
  if (!isRiskLevel(riskLevel)) throw new Error('工具 ' + name + ' 的 riskLevel 不合法');
  return {
    name,
    description,
    inputSchema: s.inputSchema,
    riskLevel,
    execute: s.execute,
  };
}

export function createToolRegistry() {
  const tools = new Map();

  return {
    /** 注册（重复注册直接抛错，避免两个同名工具谁也说不清用哪个） */
    register(spec) {
      const tool = defineTool(spec);
      if (tools.has(tool.name)) throw new Error('工具重复注册：' + tool.name);
      tools.set(tool.name, tool);
      return tool;
    },
    registerAll(specs) {
      const out = [];
      for (const spec of specs || []) out.push(this.register(spec));
      return out;
    },
    has(name) {
      return tools.has(String(name));
    },
    get(name) {
      return tools.get(String(name)) || null;
    },
    names() {
      return Array.from(tools.keys());
    },
    /** 按名字排序，保证给模型的工具顺序稳定（顺序变了 prompt 缓存就废了） */
    list() {
      return Array.from(tools.values()).sort((a, b) => (a.name < b.name ? -1 : 1));
    },
    size() {
      return tools.size;
    },
  };
}

function typeOk(spec, value) {
  switch (spec.type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return !!value && typeof value === 'object' && !Array.isArray(value);
    default: return false;
  }
}

/**
 * 校验模型给的参数。
 * 不抛错，返回 { ok, errors, value } —— 参数错误要作为「工具结果」回给模型，
 * 让它自己改，而不是把整个 run 打断。
 */
export function validateArgs(tool, args) {
  const errors = [];
  const schema = (tool && tool.inputSchema) || { type: 'object', properties: {} };
  const raw = (args && typeof args === 'object' && !Array.isArray(args)) ? args : null;
  if (raw === null) {
    return { ok: false, errors: ['参数必须是 JSON 对象'], value: {} };
  }
  const props = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const value = {};

  for (const key of required) {
    if (raw[key] === undefined || raw[key] === null || raw[key] === '') {
      errors.push('缺少必填参数：' + key);
    }
  }
  for (const [key, spec] of Object.entries(props)) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    if (!typeOk(spec, v)) {
      // 模型经常把 number 写成字符串，宽松一点：能转就转
      if (spec.type === 'number' || spec.type === 'integer') {
        const n = Number(v);
        if (Number.isFinite(n)) { value[key] = spec.type === 'integer' ? Math.round(n) : n; continue; }
      }
      if (spec.type === 'string' && (typeof v === 'number' || typeof v === 'boolean')) {
        value[key] = String(v);
        continue;
      }
      errors.push('参数 ' + key + ' 类型应为 ' + spec.type);
      continue;
    }
    if (spec.enum && !spec.enum.includes(v)) {
      errors.push('参数 ' + key + ' 只能是：' + spec.enum.join(' / '));
      continue;
    }
    value[key] = v;
  }

  // 未知参数丢掉（模型偶尔会编字段），但不因此判失败
  return { ok: errors.length === 0, errors, value };
}

/**
 * TOOL_SPECS 是**元信息**（名字 / 参数 / 风险），执行由 executor 提供。
 * 但注册表要求每个工具都有 execute，所以这里给它们挂一个会明确报错的默认实现 ——
 * 「忘了接线」必须是一句清楚的话，而不是 undefined is not a function。
 */
function unbound() {
  throw new Error('这个工具还没有接到宿主实现（应该通过 attachExecutors 装配）');
}

export function withBaseExecutors(specs) {
  const list = specs || TOOL_SPECS;
  for (const spec of list) {
    if (typeof spec.execute !== 'function') spec.execute = unbound;
  }
  return list;
}

/**
 * 把 executor 的实现接到工具定义上。
 * 为什么要有这一步：工具「叫什么、要什么参数、多危险」是元信息（TOOL_SPECS），
 * 「怎么执行」是宿主的能力（executor）。注册表只认完整定义，所以这里做装配。
 */
export function attachExecutors(specs, executor) {
  return withBaseExecutors(specs).map((spec) => Object.assign({}, spec, {
    execute: async (args) => {
      const fn = executor && executor[spec.name];
      if (typeof fn !== 'function') throw new Error('executor 未实现工具：' + spec.name);
      return fn(args);
    },
  }));
}

export const TOOL_SPECS = [
  {
    name: 'list_files',
    riskLevel: RISK.LOW,
    description: '列出一个目录下的文件与子目录。路径必须位于 workspace 内。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对 workspace 的目录路径，默认 "."' },
        depth: { type: 'integer', description: '递归层数，1 表示只看当前层' },
      },
      required: [],
    },
  },
  {
    name: 'search_files',
    riskLevel: RISK.LOW,
    description: '在 workspace 内按文本内容搜索（字面量匹配，不是正则）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜索的文本' },
        path: { type: 'string', description: '搜索起点目录，默认 "."' },
        maxResults: { type: 'integer', description: '最多返回多少条，默认 50' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_file',
    riskLevel: RISK.LOW,
    description: '读取 workspace 内某个文本文件的内容（带行号）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对 workspace 的文件路径' },
        offset: { type: 'integer', description: '从第几行开始，默认 1' },
        limit: { type: 'integer', description: '最多读多少行，默认 400' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    riskLevel: RISK.MEDIUM,
    description: '把内容写入 workspace 内的文件（覆盖或新建）。这是会改磁盘的操作。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对 workspace 的文件路径' },
        content: { type: 'string', description: '完整文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'apply_patch',
    riskLevel: RISK.MEDIUM,
    description: '对 workspace 内的文件做一次精确文本替换（old 必须唯一出现）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对 workspace 的文件路径' },
        old: { type: 'string', description: '要被替换的原文（必须唯一）' },
        new: { type: 'string', description: '替换成的新文本' },
      },
      required: ['path', 'old', 'new'],
    },
  },
  {
    name: 'run_command',
    riskLevel: RISK.HIGH,
    description: '在 workspace 内执行一条命令（白名单校验，不经 shell 解析）。必须用户确认。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的程序，如 node / npm / git' },
        args: { type: 'array', items: { type: 'string' }, description: '参数数组' },
        timeoutMs: { type: 'integer', description: '超时毫秒数，默认 60000' },
      },
      required: ['command'],
    },
  },
  {
    name: 'git_status',
    riskLevel: RISK.LOW,
    description: '查看 workspace 的 git 状态（等价 git status --short）。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'git_diff',
    riskLevel: RISK.LOW,
    description: '查看 workspace 的未提交改动（等价 git diff），可指定相对路径。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '只看某个路径的改动，默认全部' },
        staged: { type: 'boolean', description: 'true 看已暂存的改动' },
      },
      required: [],
    },
  },
  {
    name: 'git_commit',
    riskLevel: RISK.MEDIUM,
    description: '把已暂存的改动提交（等价 git commit -m）。不会自动 add，也不会 push。',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '提交信息' },
      },
      required: ['message'],
    },
  },
  {
    name: 'screen_capture',
    riskLevel: RISK.LOW,
    description: '截取当前屏幕，返回图片尺寸与（可选的）图像数据。用于「看一眼界面/报错窗口」。',
    inputSchema: {
      type: 'object',
      properties: {
        withData: { type: 'boolean', description: '是否需要返回 base64 图像数据' },
      },
      required: [],
    },
  },

  // ---- 电脑控制（Desktop / Computer Tools）----
  // 读类（看窗口）是 LOW；一切**动手改电脑状态**的都是 HIGH，默认必须用户确认。
  {
    name: 'window_list',
    riskLevel: RISK.LOW,
    description: '列出当前可见的窗口标题，用来判断该操作哪个窗口。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'window_focus',
    riskLevel: RISK.HIGH,
    description: '把某个标题匹配的窗口切到前台（会打断用户正在做的事）。必须用户确认。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '窗口标题里的关键词' },
      },
      required: ['title'],
    },
  },
  {
    name: 'open_application',
    riskLevel: RISK.HIGH,
    description: '打开程序或网址（浏览器、记事本、某个链接）。必须用户确认。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'http(s) 链接或程序名，例如 https://example.com 或 notepad' },
      },
      required: ['target'],
    },
  },
  {
    name: 'mouse_move',
    riskLevel: RISK.HIGH,
    description: '把鼠标指针移动到屏幕坐标 (x, y)。必须用户确认。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'integer', description: '屏幕 x 坐标' },
        y: { type: 'integer', description: '屏幕 y 坐标' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'mouse_click',
    riskLevel: RISK.HIGH,
    description: '在当前指针位置点击鼠标（可指定左右键、是否双击）。必须用户确认。',
    inputSchema: {
      type: 'object',
      properties: {
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: '哪个键，默认 left' },
        double: { type: 'boolean', description: '是否双击' },
      },
      required: [],
    },
  },
  {
    name: 'keyboard_type',
    riskLevel: RISK.HIGH,
    description: '向当前焦点窗口输入一段文字。必须用户确认。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要输入的文字（最多 2000 字符）' },
      },
      required: ['text'],
    },
  },
  {
    name: 'keyboard_press',
    riskLevel: RISK.HIGH,
    description: '按下快捷键，例如 ["ctrl","c"]、["enter"]。必须用户确认。',
    inputSchema: {
      type: 'object',
      properties: {
        keys: { type: 'array', items: { type: 'string' }, description: '按键数组，组合键用多个元素表示' },
      },
      required: ['keys'],
    },
  },
];

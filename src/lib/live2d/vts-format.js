// ============================================================
// VTube Studio 模型格式的解析层（纯函数，可单测）
//
// 只做三件事：
//   1) 把 .exp3.json 解析成「参数指令列表」，并给出明确的成功/失败原因；
//   2) 把 .vtube.json 的热键表解析成「可执行 / 不支持 + 原因」；
//   3) 把 .cdi3.json 的部件表解析成「有名字的部件」，重名加序号。
//
// 纪律：解析失败必须能说出失败原因（文件不存在 / JSON 坏了 / 参数为空 / 没有可用参数），
// 绝不允许把失败转换成「空数组」让上层以为是成功。
// ============================================================

/** 表达式文件里允许的 Blend 值（exp3 规范只有这三种） */
const BLEND_KIND = new Set(['overwrite', 'add', 'multiply', 'mul']);

export function normalizeBlendName(blend) {
  const kind = String(blend || 'overwrite').toLowerCase();
  if (kind === 'add') return 'Add';
  if (kind === 'multiply' || kind === 'mul') return 'Multiply';
  return 'Overwrite';
}

/**
 * 解析 .exp3.json。
 * @param {object} json  已经 parse 出来的对象
 * @returns {{ok:boolean, params:Array<{id:string,value:number,blend:string}>, error?:string, warnings:string[]}}
 */
export function parseExpression(json) {
  const warnings = [];
  if (!json || typeof json !== 'object') {
    return { ok: false, params: [], warnings, error: '表达式内容不是对象（JSON 可能损坏）' };
  }
  const raw = Array.isArray(json.Parameters) ? json.Parameters : null;
  const rawParts = Array.isArray(json.Parts) ? json.Parts : null;
  if (!raw && !rawParts) {
    return { ok: false, params: [], warnings, error: '表达式里没有 Parameters 字段（不是 exp3 格式）' };
  }
  const params = [];
  for (const p of (raw || [])) {
    const id = String((p && (p.Id || p.id)) || '');
    if (!id) { warnings.push('跳过一条没有 Id 的参数'); continue; }
    const value = Number(p.Value !== undefined ? p.Value : p.value);
    if (!Number.isFinite(value)) { warnings.push('参数 ' + id + ' 的 Value 不是数字，已跳过'); continue; }
    const blendRaw = p.Blend !== undefined ? p.Blend : p.blend;
    if (blendRaw && !BLEND_KIND.has(String(blendRaw).toLowerCase())) {
      warnings.push('参数 ' + id + ' 的 Blend「' + blendRaw + '」不认识，按 Overwrite 处理');
    }
    params.push({ id, value, blend: normalizeBlendName(blendRaw) });
  }
  // exp3 也允许直接写部件不透明度（Parts），先收集起来，交给部件层用
  const parts = [];
  for (const p of (rawParts || [])) {
    const id = String((p && (p.Id || p.id)) || '');
    const value = Number(p && (p.Value !== undefined ? p.Value : p.value));
    if (id && Number.isFinite(value)) parts.push({ id, value });
  }
  if (!params.length && !parts.length) {
    return { ok: false, params: [], parts, warnings, error: '表达式里没有任何有效参数' };
  }
  return { ok: true, params, parts, warnings, error: null };
}

/**
 * 多个表达式同时生效时，把它们的参数按「激活顺序」合并成每个参数的合成值。
 * 语义：后应用的表达式在上一个结果上继续叠加（Add/Multiply 用中间值当基线，Overwrite 直接覆盖），
 * 与 VTS 的表达式层叠行为一致（VTS 也是按激活顺序依次叠加）。
 *
 * @param {Array<{id:string, params:Array}>} active  激活中的表达式（按顺序）
 * @param {(id:string)=>number} baseOf               参数基线（不受表达式影响的值）
 * @returns {{ order:string[], values:object, blamed:object }}
 */
export function mergeExpressions(active, baseOf) {
  const values = {};
  const order = [];
  const blamed = {};
  for (const item of (active || [])) {
    for (const p of (item && item.params) || []) {
      const id = String(p.id);
      const base = Object.prototype.hasOwnProperty.call(values, id)
        ? values[id]
        : (typeof baseOf === 'function' ? Number(baseOf(id)) : 0);
      const kind = String(p.blend || 'Overwrite').toLowerCase();
      let next;
      if (kind === 'add') next = base + Number(p.value);
      else if (kind === 'multiply' || kind === 'mul') next = base * Number(p.value);
      else next = Number(p.value);
      if (!Number.isFinite(next)) continue;
      values[id] = next;
      if (!order.includes(id)) order.push(id);
      blamed[id] = item.id || item.file || '';
    }
  }
  return { order, values, blamed };
}

/** 热键动作：目前只做「切表达式」和「清空表达式」，其它明确标记为不支持（不假装成功） */
const SUPPORTED_ACTIONS = {
  ToggleExpression: 'toggle-expression',
  RemoveAllExpressions: 'remove-all',
};

export const UNSUPPORTED_REASON = 'AILEEN 只实现了 ToggleExpression / RemoveAllExpressions，其它 VTS 动作（移动模型、换物品、参数直推等）暂不支持';

/**
 * 解析 .vtube.json 的热键表。
 * @returns {{hotkeys:Array, unsupported:Array, total:number}}
 *   hotkeys: [{ name, action, kind, file, supported:true }]
 *   unsupported: [{ name, action, supported:false, reason }]
 */
export function parseHotkeys(vtubeJson) {
  const list = (vtubeJson && Array.isArray(vtubeJson.Hotkeys)) ? vtubeJson.Hotkeys : [];
  const hotkeys = [];
  const unsupported = [];
  for (const h of list) {
    const name = String((h && (h.Name || h.name)) || '').trim();
    const action = String((h && (h.Action || h.action)) || '').trim();
    const file = String((h && (h.File || h.file)) || '').trim();
    if (!name) continue;
    const kind = SUPPORTED_ACTIONS[action];
    if (!kind) {
      unsupported.push({ name, action, supported: false, reason: UNSUPPORTED_REASON });
      continue;
    }
    if (kind === 'toggle-expression' && !file) {
      unsupported.push({ name, action, supported: false, reason: '热键没有指定表达式文件（File 为空）' });
      continue;
    }
    hotkeys.push({ name, action, kind, file, supported: true });
  }
  return { hotkeys, unsupported, total: list.length };
}

/**
 * 把热键里的相对路径拼到模型目录上。
 * 拒绝：绝对路径、盘符、`..` 穿越、`http(s)://`、`javascript:` —— 模型目录是外部数据。
 * @returns {string|null} 拼好的绝对 URL（base 是模型目录的 http URL），非法返回 null
 */
export function resolveModelFileUrl(baseDirUrl, file) {
  const name = String(file || '').trim();
  if (!name) return null;
  if (/^(?:[a-z]+:)?\/\//i.test(name)) return null;      // 绝对 URL / 协议相对
  if (/^[a-z]:[\\/]/i.test(name)) return null;           // Windows 盘符
  if (name.startsWith('/') || name.startsWith('\\')) return null;
  const parts = name.replace(/\\/g, '/').split('/');
  if (parts.some((p) => p === '..')) return null;        // 目录穿越
  const clean = parts.filter((p) => p && p !== '.').join('/');
  if (!clean) return null;
  const base = String(baseDirUrl || '');
  if (!base) return null;
  return base.endsWith('/') ? base + clean : base + '/' + clean;
}

/** 模型 URL → 目录 URL（拼 .vtube.json / .cdi3.json / .exp3.json 用） */
export function modelDirUrl(modelUrl) {
  const url = String(modelUrl || '');
  const cut = url.lastIndexOf('/');
  return cut >= 0 ? url.slice(0, cut + 1) : '';
}

/** 模型 URL → 去掉 .model3.json 的前缀（VTS 的配置文件就放在这个名字旁边） */
export function modelBaseUrl(modelUrl) {
  return String(modelUrl || '').replace(/\.model3?\.json$/i, '');
}

/**
 * 解析 .cdi3.json 的部件表。
 * 过滤掉导出工具生成的占位名（x / Part12 / ArtMesh33_Skinning 这种），重名加序号。
 * @param {object} cdi3
 * @param {Map<string,number>} indexById 运行时部件表（core getPartId 建出来的）
 */
export function parseParts(cdi3, indexById) {
  const list = (cdi3 && Array.isArray(cdi3.Parts)) ? cdi3.Parts : [];
  const junk = /^(x|part|part\d+|artmesh\d+(_skinning)?|layer\d*|group\d*)$/i;
  const parts = [];
  for (const p of list) {
    const id = String((p && p.Id) || '');
    const name = String((p && p.Name) || '').replace(/\.[a-z0-9]+$/i, '').trim();
    if (!id || !name) continue;
    if (junk.test(name)) continue;
    if (!(indexById instanceof Map) || !indexById.has(id)) continue;
    parts.push({ id, name, index: indexById.get(id) });
  }
  const count = new Map();
  for (const p of parts) count.set(p.name, (count.get(p.name) || 0) + 1);
  const used = new Map();
  for (const p of parts) {
    if (count.get(p.name) > 1) {
      const n = (used.get(p.name) || 0) + 1;
      used.set(p.name, n);
      p.label = p.name + ' (' + n + ')';
    } else {
      p.label = p.name;
    }
  }
  return parts;
}

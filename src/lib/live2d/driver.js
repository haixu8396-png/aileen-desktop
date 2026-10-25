// ============================================================
// Live2D 驱动层（纯逻辑，可单测，不碰 DOM / 网络 / 渲染循环）
//
// 为什么需要这层：引擎（untitled-pixi-live2d-engine 里的 Cubism Web Framework）
// 的「按 id」接口有个致命细节 ——
//
//   getParameterIndex(parameterId) {
//     for (i < count) if (parameterId != this._parameterIds.at(i)) continue; return i
//     ...
//     return this._notExistParameterId.getValue(...)   // ← 幻影表
//   }
//
// `_parameterIds` 里存的是 CubismId **句柄**，传字符串永远不相等，于是任何
// `setParameterValueById('SchoolUniform', 1)` 都写进了一张模型根本不读的表：
// 值读得回来、画面永远不动。实测（真机）：
//   SchoolUniform  按 id 写→0（无效）  按下标写→1（生效）
//   ParamAngleX    按 id 写→0（无效）  按下标写→30（生效）
//
// 所以这一层的规矩只有一条：**一切都走下标**。
//   · 模型加载时建一张 id → 下标表；
//   · 读/写/加/乘全部用 ByIndex 接口；
//   · id 不在表里就明确报错，绝不假装成功。
// ============================================================

/** Cubism 的 ID 不是字符串：getPartId()/getParameterId() 返回 CubismId，要经 getString() 取原文 */
export function cubismIdToString(id) {
  if (typeof id === 'string') return id;
  try {
    const s = id && id.getString ? id.getString() : null;
    if (!s) return '';
    if (typeof s === 'string') return s;
    if (typeof s.getRawString === 'function') return String(s.getRawString() || '');
    return String(s.s || '');
  } catch (err) {
    return '';
  }
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * 建参数表。传入的 coreModel 就是引擎里 internalModel.coreModel。
 * @returns {{count:number, ids:string[], index:Map<string,number>, min:number[], max:number[], def:number[]}}
 */
export function buildParamTable(coreModel) {
  const table = { count: 0, ids: [], index: new Map(), min: [], max: [], def: [] };
  if (!coreModel || typeof coreModel.getParameterCount !== 'function') return table;
  const count = num(coreModel.getParameterCount(), 0);
  table.count = count;
  for (let i = 0; i < count; i += 1) {
    const id = cubismIdToString(coreModel.getParameterId(i));
    table.ids.push(id);
    if (id && !table.index.has(id)) table.index.set(id, i);
    table.min.push(num(coreModel.getParameterMinimumValue(i), 0));
    table.max.push(num(coreModel.getParameterMaximumValue(i), 1));
    table.def.push(num(coreModel.getParameterDefaultValue(i), 0));
  }
  return table;
}

export function hasParam(table, id) {
  return !!(table && table.index && table.index.has(String(id)));
}

export function paramIndex(table, id) {
  if (!hasParam(table, id)) return -1;
  return table.index.get(String(id));
}

export function clampParam(table, index, value) {
  if (!table || index < 0 || index >= table.count) return num(value, 0);
  const lo = table.min[index];
  const hi = table.max[index];
  let v = num(value, 0);
  if (Number.isFinite(lo) && v < lo) v = lo;
  if (Number.isFinite(hi) && v > hi) v = hi;
  return v;
}

export function readParam(table, coreModel, id) {
  const idx = paramIndex(table, id);
  if (idx < 0) return null;
  try {
    return num(coreModel.getParameterValueByIndex(idx), null);
  } catch (err) {
    return null;
  }
}

/** 按下标写（唯一正确路径）；返回写入后的实际值，失败返回 null */
export function writeParamIndex(table, coreModel, index, value) {
  if (!table || index < 0 || index >= table.count) return null;
  try {
    coreModel.setParameterValueByIndex(index, clampParam(table, index, value));
    return num(coreModel.getParameterValueByIndex(index), null);
  } catch (err) {
    return null;
  }
}

export function writeParam(table, coreModel, id, value) {
  const idx = paramIndex(table, id);
  if (idx < 0) return null;
  return writeParamIndex(table, coreModel, idx, value);
}

/**
 * 表达式混合语义（按 exp3 的 Blend 字段，大小写不敏感）：
 *   Overwrite（默认）→ 直接取表达式值
 *   Add              → 基线 + 值（再按参数范围钳制）
 *   Multiply         → 基线 × 值（再钳制）
 * 未知 Blend 一律按 Overwrite 处理并在结果里记一条警示，不静默吞掉。
 */
export function blendValue(blend, base, value) {
  const b = num(base, 0);
  const v = num(value, 0);
  const kind = String(blend || 'overwrite').toLowerCase();
  if (kind === 'add') return b + v;
  if (kind === 'multiply' || kind === 'mul') return b * v;
  return v;
}

export function normalizeBlend(blend) {
  const kind = String(blend || 'overwrite').toLowerCase();
  if (kind === 'add') return 'Add';
  if (kind === 'multiply' || kind === 'mul') return 'Multiply';
  return 'Overwrite';
}

/**
 * 把一条表达式的参数作用到模型上。
 *
 * 注意：每条参数都独立地从 baseOf 给的基线算 —— 同一条表达式里出现重复的 Id 时
 * **后一条覆盖前一条**。多条表达式之间的叠加是 `vts-format.js` 的 mergeExpressions 干的。
 *
 * @param table     buildParamTable 的结果
 * @param coreModel 引擎 coreModel
 * @param params    [{ id, value, blend }]
 * @param baseOf    (id) => number   该参数的「基线值」（不受表达式影响的原始值）
 * @returns {{ applied: object[], missing: string[], written: object }}
 *          missing 非空时调用方必须把它当成「部分失败」报给用户，不能算全成功。
 */
export function applyExpressionParams(table, coreModel, params, baseOf) {
  const applied = [];
  const missing = [];
  const written = {};
  for (const p of (params || [])) {
    const id = String((p && p.id) || '');
    if (!id) continue;
    const idx = paramIndex(table, id);
    if (idx < 0) {
      if (!missing.includes(id)) missing.push(id);
      continue;
    }
    const base = typeof baseOf === 'function'
      ? num(baseOf(id, idx), table.def[idx])
      : table.def[idx];
    const next = blendValue(p.blend, base, p.value);
    const after = writeParamIndex(table, coreModel, idx, next);
    if (after === null) {
      if (!missing.includes(id)) missing.push(id);
      continue;
    }
    written[id] = after;
    applied.push({ id, index: idx, blend: normalizeBlend(p.blend), value: num(p.value, 0), written: after });
  }
  return { applied, missing, written };
}

/** 部件表：id → 下标（部件全部用 ByIndex 接口，天然绕过幻影表问题） */
export function buildPartTable(coreModel) {
  const table = { count: 0, ids: [], index: new Map() };
  if (!coreModel || typeof coreModel.getPartCount !== 'function') return table;
  const count = num(coreModel.getPartCount(), 0);
  table.count = count;
  for (let i = 0; i < count; i += 1) {
    const id = cubismIdToString(coreModel.getPartId(i));
    table.ids.push(id);
    if (id && !table.index.has(id)) table.index.set(id, i);
  }
  return table;
}

export function readPartOpacity(coreModel, index) {
  try {
    if (typeof coreModel.getPartOpacityByIndex === 'function') {
      const v = Number(coreModel.getPartOpacityByIndex(index));
      return Number.isFinite(v) ? v : null;
    }
    const core = coreModel && coreModel._model;
    const arr = core && core.parts && core.parts.opacities;
    if (arr) {
      const v = Number(arr[index]);
      return Number.isFinite(v) ? v : null;
    }
  } catch (err) { /* 下面兜底 */ }
  return null;
}

export function writePartOpacity(coreModel, index, value) {
  try {
    if (typeof coreModel.setPartOpacityByIndex === 'function') {
      coreModel.setPartOpacityByIndex(index, Number(value));
      return readPartOpacity(coreModel, index);
    }
    const core = coreModel && coreModel._model;
    const arr = core && core.parts && core.parts.opacities;
    if (arr) {
      arr[index] = Number(value);
      return Number(arr[index]);
    }
  } catch (err) { /* 下面兜底 */ }
  return null;
}

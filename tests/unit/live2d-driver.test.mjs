import { describe, it, expect } from 'vitest';
import {
  cubismIdToString, buildParamTable, hasParam, paramIndex, clampParam,
  readParam, writeParamIndex, writeParam, blendValue, normalizeBlend,
  applyExpressionParams, buildPartTable, readPartOpacity, writePartOpacity,
} from '../../src/lib/live2d/driver.js';

/**
 * 假 coreModel：**故意复刻引擎那个坏掉的行为** ——
 * getParameterIndex(string) 永远返回 -1（真实引擎是分配一个幻影下标），
 * ById 的读写进一张模型不读的表，只有 ByIndex 真的改参数。
 */
function makeCoreModel({ params = [], parts = [] } = {}) {
  const state = {
    values: params.map((p) => (p.def !== undefined ? p.def : 0)),
    opacities: parts.map((p) => (p.opacity !== undefined ? p.opacity : 1)),
    phantom: new Map(),
    calls: { byIdWrites: 0, byIndexWrites: 0 },
  };
  const ids = params.map((p) => ({ getString: () => ({ getRawString: () => p.id }) }));
  const partIds = parts.map((p) => ({ getString: () => ({ getRawString: () => p.id }) }));
  return {
    state,
    getParameterCount: () => params.length,
    getParameterId: (i) => ids[i],
    getParameterMinimumValue: (i) => params[i].min,
    getParameterMaximumValue: (i) => params[i].max,
    getParameterDefaultValue: (i) => params[i].def,
    getParameterValueByIndex: (i) => state.values[i],
    setParameterValueByIndex: (i, v) => { state.values[i] = v; state.calls.byIndexWrites += 1; },
    // ↓ 坏接口：写进幻影表，模型永远不读
    getParameterValueById: (id) => (state.phantom.has(String(id)) ? state.phantom.get(String(id)) : -1),
    setParameterValueById: (id, v) => { state.phantom.set(String(id), v); state.calls.byIdWrites += 1; },
    getParameterIndex: () => -1,
    getPartCount: () => parts.length,
    getPartId: (i) => partIds[i],
    getPartOpacityByIndex: (i) => state.opacities[i],
    setPartOpacityByIndex: (i, v) => { state.opacities[i] = v; },
  };
}

const MODEL = {
  params: [
    { id: 'ParamAngleX', min: -30, max: 30, def: 0 },
    { id: 'SchoolUniform', min: 0, max: 1, def: 0 },
    { id: 'ParamMouthOpenY', min: 0, max: 1, def: 0 },
  ],
  parts: [
    { id: 'Part64', opacity: 1 },
    { id: 'Part11', opacity: 0.6 },
  ],
};

describe('driver：ID 解析', () => {
  it('CubismId 三种形态都能取出原字符串', () => {
    expect(cubismIdToString('ParamAngleX')).toBe('ParamAngleX');
    expect(cubismIdToString({ getString: () => ({ getRawString: () => 'A' }) })).toBe('A');
    expect(cubismIdToString({ getString: () => 'B' })).toBe('B');
    expect(cubismIdToString({ getString: () => null })).toBe('');
    expect(cubismIdToString(null)).toBe('');
    expect(cubismIdToString({ getString() { throw new Error('boom'); } })).toBe('');
  });
});

describe('driver：参数表', () => {
  it('按 id 建下标表，范围/默认值都取到', () => {
    const cm = makeCoreModel(MODEL);
    const t = buildParamTable(cm);
    expect(t.count).toBe(3);
    expect(paramIndex(t, 'ParamAngleX')).toBe(0);
    expect(paramIndex(t, 'SchoolUniform')).toBe(1);
    expect(paramIndex(t, '不存在的参数')).toBe(-1);
    expect(t.min).toEqual([-30, 0, 0]);
    expect(t.max).toEqual([30, 1, 1]);
    expect(t.def).toEqual([0, 0, 0]);
  });

  it('没有引擎对象时是空表，不抛错', () => {
    const t = buildParamTable(null);
    expect(t.count).toBe(0);
    expect(hasParam(t, 'ParamAngleX')).toBe(false);
    expect(hasParam(null, 'x')).toBe(false);
  });

  it('重名 id 只取第一次出现的下标（和引擎一致）', () => {
    const cm = makeCoreModel({ params: [{ id: 'A', min: 0, max: 1, def: 0 }, { id: 'A', min: 0, max: 1, def: 0 }] });
    expect(buildParamTable(cm).index.get('A')).toBe(0);
  });

  it('clampParam 收敛到参数范围，坏值当 0', () => {
    const t = buildParamTable(makeCoreModel(MODEL));
    expect(clampParam(t, 0, 99)).toBe(30);
    expect(clampParam(t, 0, -99)).toBe(-30);
    expect(clampParam(t, 0, 12)).toBe(12);
    expect(clampParam(t, 0, Number.NaN)).toBe(0);
    expect(clampParam(t, 99, 5)).toBe(5);
  });
});

describe('driver：参数写入必须走下标', () => {
  it('writeParam 真的改到模型的值（ByIndex），ById 完全没被碰过', () => {
    const cm = makeCoreModel(MODEL);
    const t = buildParamTable(cm);
    const after = writeParam(t, cm, 'SchoolUniform', 1);
    expect(after).toBe(1);
    expect(cm.state.values[1]).toBe(1);
    expect(cm.state.calls.byIdWrites).toBe(0);        // 一次都没有走坏接口
    expect(cm.state.phantom.size).toBe(0);
  });

  it('WriteParam 对不存在的参数返回 null，不假装成功', () => {
    const cm = makeCoreModel(MODEL);
    const t = buildParamTable(cm);
    expect(writeParam(t, cm, 'NoSuch', 1)).toBe(null);
    expect(writeParamIndex(t, cm, -1, 1)).toBe(null);
    expect(writeParamIndex(t, cm, 99, 1)).toBe(null);
  });

  it('写入时按参数范围钳制', () => {
    const cm = makeCoreModel(MODEL);
    const t = buildParamTable(cm);
    expect(writeParam(t, cm, 'ParamAngleX', 1000)).toBe(30);
    expect(writeParam(t, cm, 'ParamAngleX', -1000)).toBe(-30);
  });

  it('readParam 按 id 读下标值；引擎抛错时返回 null', () => {
    const cm = makeCoreModel(MODEL);
    const t = buildParamTable(cm);
    cm.state.values[0] = 12.5;
    expect(readParam(t, cm, 'ParamAngleX')).toBe(12.5);
    expect(readParam(t, cm, 'NoSuch')).toBe(null);
    cm.getParameterValueByIndex = () => { throw new Error('boom'); };
    expect(readParam(t, cm, 'ParamAngleX')).toBe(null);
  });
});

describe('driver：Blend 语义', () => {
  it('三种 Blend 的取值', () => {
    expect(blendValue('Overwrite', 5, 2)).toBe(2);
    expect(blendValue('Add', 5, 2)).toBe(7);
    expect(blendValue('Multiply', 5, 2)).toBe(10);
    expect(blendValue('mul', 5, 2)).toBe(10);
    expect(blendValue(undefined, 5, 2)).toBe(2);   // 默认 Overwrite
    expect(blendValue('Overwrite', 5, Number.NaN)).toBe(0);
  });

  it('normalizeBlend 把大小写/别名统一', () => {
    expect(normalizeBlend('add')).toBe('Add');
    expect(normalizeBlend('ADD')).toBe('Add');
    expect(normalizeBlend('Multiply')).toBe('Multiply');
    expect(normalizeBlend('mul')).toBe('Multiply');
    expect(normalizeBlend('Overwrite')).toBe('Overwrite');
    expect(normalizeBlend('啥也不是')).toBe('Overwrite');
    expect(normalizeBlend(null)).toBe('Overwrite');
  });
});

describe('driver：applyExpressionParams', () => {
  it('Overwrite / Add / Multiply 都写在基线上，并按顺序叠加', () => {
    const cm = makeCoreModel(MODEL);
    const t = buildParamTable(cm);
    cm.state.values[0] = 10;   // ParamAngleX 基线
    const r = applyExpressionParams(t, cm, [
      { id: 'ParamAngleX', value: 5, blend: 'Add' },        // 10 + 5 = 15
      { id: 'SchoolUniform', value: 1, blend: 'Overwrite' },
    ], () => null);
    // baseOf 返回 null → 用表的默认值 0
    expect(r.written.ParamAngleX).toBe(5);
    expect(r.written.SchoolUniform).toBe(1);
    expect(r.missing).toEqual([]);
  });

  it('baseOf 提供真实基线时 Add/Multiply 结果正确', () => {
    const cm = makeCoreModel(MODEL);
    const t = buildParamTable(cm);
    const add = applyExpressionParams(t, cm, [{ id: 'ParamAngleX', value: 5, blend: 'Add' }], () => 10);
    expect(add.written.ParamAngleX).toBe(15);       // 10 + 5
    cm.state.values[1] = 10;
    const mul = applyExpressionParams(t, cm, [{ id: 'ParamAngleX', value: 2, blend: 'Multiply' }], () => 10);
    expect(mul.written.ParamAngleX).toBe(20);       // 10 × 2
  });

  it('同一条表达式里重复写同一个参数：后一条赢（叠加交给 mergeExpressions）', () => {
    const cm = makeCoreModel(MODEL);
    const t = buildParamTable(cm);
    const r = applyExpressionParams(t, cm, [
      { id: 'ParamAngleX', value: 5, blend: 'Add' },
      { id: 'ParamAngleX', value: 2, blend: 'Multiply' },
    ], () => 10);
    // 每条都从 baseOf 的基线算：最后一条 10 × 2 = 20（第二条覆盖第一条）
    expect(r.written.ParamAngleX).toBe(20);
    expect(r.applied.length).toBe(2);
  });

  it('结果被参数范围钳制', () => {
    const cm = makeCoreModel(MODEL);
    const t = buildParamTable(cm);
    const r = applyExpressionParams(t, cm, [{ id: 'ParamAngleX', value: 999, blend: 'Overwrite' }], () => 0);
    expect(r.written.ParamAngleX).toBe(30);
  });

  it('参数不在模型里 → 进 missing，不算 applied', () => {
    const cm = makeCoreModel(MODEL);
    const t = buildParamTable(cm);
    const r = applyExpressionParams(t, cm, [
      { id: 'ParamAngleX', value: 1, blend: 'Overwrite' },
      { id: '__没有这个__', value: 1, blend: 'Overwrite' },
    ], () => 0);
    expect(r.missing).toEqual(['__没有这个__']);
    expect(r.applied.map((a) => a.id)).toEqual(['ParamAngleX']);
  });

  it('空输入不炸，返回空结果', () => {
    const t = buildParamTable(makeCoreModel(MODEL));
    expect(applyExpressionParams(t, makeCoreModel(MODEL), null, null)).toEqual({ applied: [], missing: [], written: {} });
    expect(applyExpressionParams(t, makeCoreModel(MODEL), [], null).applied).toEqual([]);
  });
});

describe('driver：部件不透明度', () => {
  it('建部件表并能读回原始不透明度', () => {
    const cm = makeCoreModel(MODEL);
    const t = buildPartTable(cm);
    expect(t.count).toBe(2);
    expect(t.index.get('Part11')).toBe(1);
    expect(readPartOpacity(cm, 1)).toBe(0.6);
  });

  it('写 0 再写回原值（这是「恢复」的关键）', () => {
    const cm = makeCoreModel(MODEL);
    const original = readPartOpacity(cm, 1);
    expect(writePartOpacity(cm, 1, 0)).toBe(0);
    expect(writePartOpacity(cm, 1, original)).toBe(0.6);
  });

  it('接口缺失时返回 null，而不是编一个值出来', () => {
    expect(readPartOpacity({}, 0)).toBe(null);
    expect(writePartOpacity({}, 0, 0)).toBe(null);
    expect(readPartOpacity(null, 0)).toBe(null);
  });

  it('没有 ByIndex 接口时退回 core 数组', () => {
    const core = { _model: { parts: { opacities: [0.3] } } };
    expect(readPartOpacity(core, 0)).toBe(0.3);
    expect(writePartOpacity(core, 0, 0.9)).toBe(0.9);
  });
});

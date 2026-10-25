import { describe, it, expect } from 'vitest';
import {
  normalizeBlendName, parseExpression, mergeExpressions, parseHotkeys,
  resolveModelFileUrl, modelDirUrl, modelBaseUrl, parseParts, UNSUPPORTED_REASON,
} from '../../src/lib/live2d/vts-format.js';

describe('vts-format：parseExpression', () => {
  it('正常 exp3：参数、值、Blend 都解析出来', () => {
    const r = parseExpression({
      FadeInTime: 0.2,
      Parameters: [
        { Id: 'SchoolUniform', Value: 1, Blend: 'Overwrite' },
        { Id: 'ParamAngleX', Value: 10, Blend: 'Add' },
        { Id: 'Blush2', Value: 0.5 },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.error).toBe(null);
    expect(r.params).toEqual([
      { id: 'SchoolUniform', value: 1, blend: 'Overwrite' },
      { id: 'ParamAngleX', value: 10, blend: 'Add' },
      { id: 'Blush2', value: 0.5, blend: 'Overwrite' },
    ]);
  });

  it('坏 JSON（不是对象）明确失败', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      const r = parseExpression(bad);
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
      expect(r.params).toEqual([]);
    }
  });

  it('没有 Parameters 字段（不是 exp3）明确失败', () => {
    const r = parseExpression({ FadeInTime: 0.3 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Parameters/);
  });

  it('参数全被跳过时算失败，不返回「空成功」', () => {
    const r = parseExpression({ Parameters: [{ Nope: 1 }, { Id: '', Value: 1 }] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/没有任何有效参数/);
  });

  it('Value 不是数字的那条被跳过，其它照常', () => {
    const r = parseExpression({ Parameters: [{ Id: 'A', Value: 'x' }, { Id: 'B', Value: 2 }] });
    expect(r.ok).toBe(true);
    expect(r.params.map((p) => p.id)).toEqual(['B']);
    expect(r.warnings.join('')).toMatch(/不是数字/);
  });

  it('不认识的 Blend 记一条警示，按 Overwrite 处理', () => {
    const r = parseExpression({ Parameters: [{ Id: 'A', Value: 1, Blend: 'Subtract' }] });
    expect(r.ok).toBe(true);
    expect(r.params[0].blend).toBe('Overwrite');
    expect(r.warnings.join('')).toMatch(/Subtract/);
  });

  it('Parts 段也收进来（exp3 允许直接改部件不透明度）', () => {
    const r = parseExpression({ Parts: [{ Id: 'Part64', Value: 0 }] });
    expect(r.ok).toBe(true);
    expect(r.params).toEqual([]);
    expect(r.parts).toEqual([{ id: 'Part64', value: 0 }]);
  });

  it('normalizeBlendName 与 driver 的语义一致', () => {
    expect(normalizeBlendName('Add')).toBe('Add');
    expect(normalizeBlendName('MULTIPLY')).toBe('Multiply');
    expect(normalizeBlendName(undefined)).toBe('Overwrite');
  });
});

describe('vts-format：mergeExpressions（多表达式叠加）', () => {
  it('两个 Overwrite 后开的赢', () => {
    const r = mergeExpressions([
      { id: 'A', params: [{ id: 'P', value: 1, blend: 'Overwrite' }] },
      { id: 'B', params: [{ id: 'P', value: 2, blend: 'Overwrite' }] },
    ], () => 0);
    expect(r.values.P).toBe(2);
    expect(r.blamed.P).toBe('B');
  });

  it('Add 在中间值上继续加', () => {
    const r = mergeExpressions([
      { id: 'A', params: [{ id: 'P', value: 1, blend: 'Overwrite' }] },
      { id: 'B', params: [{ id: 'P', value: 2, blend: 'Add' }] },
    ], () => 0);
    expect(r.values.P).toBe(3);
  });

  it('Multiply 乘的是叠加后的值', () => {
    const r = mergeExpressions([
      { id: 'A', params: [{ id: 'P', value: 3, blend: 'Overwrite' }] },
      { id: 'B', params: [{ id: 'P', value: 2, blend: 'Multiply' }] },
    ], () => 100);
    expect(r.values.P).toBe(6);
  });

  it('不同参数互不影响，order 保留首次出现的顺序', () => {
    const r = mergeExpressions([
      { id: 'A', params: [{ id: 'X', value: 1, blend: 'Overwrite' }] },
      { id: 'B', params: [{ id: 'Y', value: 2, blend: 'Overwrite' }, { id: 'X', value: 5, blend: 'Add' }] },
    ], () => 0);
    expect(r.order).toEqual(['X', 'Y']);
    expect(r.values.X).toBe(6);
    expect(r.values.Y).toBe(2);
  });

  it('空输入返回空结果', () => {
    expect(mergeExpressions([], () => 0)).toEqual({ order: [], values: {}, blamed: {} });
    expect(mergeExpressions(null, null)).toEqual({ order: [], values: {}, blamed: {} });
  });

  it('非数字的值被跳过，不会把 NaN 写进模型', () => {
    const r = mergeExpressions([{ id: 'A', params: [{ id: 'P', value: Number.NaN, blend: 'Add' }] }], () => 0);
    expect(r.order).toEqual([]);
    expect(r.values.P).toBe(undefined);
  });
});

describe('vts-format：parseHotkeys', () => {
  const VTUBE = {
    Hotkeys: [
      { Name: '校服', Action: 'ToggleExpression', File: '校服.exp3.json' },
      { Name: '清除', Action: 'RemoveAllExpressions' },
      { Name: '换姿势', Action: 'MoveModel', File: 'a.json' },
      { Name: '没文件', Action: 'ToggleExpression' },
      { Name: '', Action: 'ToggleExpression', File: 'x.exp3.json' },
    ],
  };

  it('支持的进 hotkeys，不支持的进 unsupported 并带原因', () => {
    const r = parseHotkeys(VTUBE);
    expect(r.total).toBe(5);
    expect(r.hotkeys.map((h) => h.name)).toEqual(['校服', '清除']);
    expect(r.hotkeys[0].kind).toBe('toggle-expression');
    expect(r.hotkeys[1].kind).toBe('remove-all');
    expect(r.unsupported.map((u) => u.name)).toEqual(['换姿势', '没文件']);
    expect(r.unsupported.every((u) => u.supported === false && u.reason)).toBe(true);
    expect(r.unsupported[0].reason).toBe(UNSUPPORTED_REASON);
    expect(r.unsupported[1].reason).toMatch(/File/);
  });

  it('没有 Hotkeys 字段就是 0 个，不报错', () => {
    expect(parseHotkeys(null)).toEqual({ hotkeys: [], unsupported: [], total: 0 });
    expect(parseHotkeys({}).hotkeys).toEqual([]);
    expect(parseHotkeys({ Hotkeys: 'x' }).hotkeys).toEqual([]);
  });
});

describe('vts-format：路径解析（模型目录是外部数据）', () => {
  it('正常相对路径拼到目录上', () => {
    expect(resolveModelFileUrl('http://127.0.0.1:1234/models/a/', 'a.exp3.json'))
      .toBe('http://127.0.0.1:1234/models/a/a.exp3.json');
    expect(resolveModelFileUrl('http://x/m/a', 'a.exp3.json')).toBe('http://x/m/a/a.exp3.json');
    expect(resolveModelFileUrl('http://x/m/a/', './sub/a.exp3.json')).toBe('http://x/m/a/sub/a.exp3.json');
    expect(resolveModelFileUrl('http://x/m/a/', 'sub\\a.exp3.json')).toBe('http://x/m/a/sub/a.exp3.json');
  });

  it('拒绝绝对 URL / 协议相对 / 盘符 / 绝对路径 / 上一级穿越', () => {
    const base = 'http://x/m/a/';
    for (const bad of ['https://evil/x.json', '//evil/x.json', 'C:\\x.json', 'c:/x.json', '/etc/passwd', '\\x.json', '../../x.json', 'a/../../x.json', '']) {
      expect(resolveModelFileUrl(base, bad)).toBe(null);
    }
    expect(resolveModelFileUrl('', 'a.json')).toBe(null);
    expect(resolveModelFileUrl(base, null)).toBe(null);
  });

  it('modelDirUrl / modelBaseUrl 从模型 URL 推出配置前缀', () => {
    const url = 'http://127.0.0.1:1/models/初音/miku.model3.json';
    expect(modelDirUrl(url)).toBe('http://127.0.0.1:1/models/初音/');
    expect(modelBaseUrl(url)).toBe('http://127.0.0.1:1/models/初音/miku');
    expect(modelDirUrl('')).toBe('');
    expect(modelBaseUrl('http://x/a.model.json')).toBe('http://x/a');
  });
});

describe('vts-format：parseParts', () => {
  const indexById = new Map([['Part1', 0], ['Part2', 1], ['Part3', 2], ['Part4', 3]]);

  it('去掉占位名、保留真实部件、重名加序号', () => {
    const cdi3 = {
      Parts: [
        { Id: 'Part1', Name: '衣服.psd' },
        { Id: 'Part2', Name: '衣服.psd' },
        { Id: 'Part3', Name: 'Part12' },      // 导出工具的占位名
        { Id: 'Part4', Name: '身体.psd' },
      ],
    };
    const parts = parseParts(cdi3, indexById);
    expect(parts.map((p) => p.label)).toEqual(['衣服 (1)', '衣服 (2)', '身体']);
    expect(parts[0].index).toBe(0);
    expect(parts[2].index).toBe(3);
  });

  it('运行时没有的部件 id 不往面板里放', () => {
    const cdi3 = { Parts: [{ Id: 'Part9', Name: '幽灵' }, { Id: 'Part1', Name: '真' }] };
    const parts = parseParts(cdi3, indexById);
    expect(parts.map((p) => p.id)).toEqual(['Part1']);
  });

  it('没有 cdi3 / 表不是 Map 时返回空数组，不抛错', () => {
    expect(parseParts(null, indexById)).toEqual([]);
    expect(parseParts({ Parts: [{ Id: 'Part1', Name: 'x1' }] }, null)).toEqual([]);
    expect(parseParts({ Parts: [{ Id: '', Name: '衣服' }] }, indexById)).toEqual([]);
    expect(parseParts({ Parts: [{ Id: 'Part1', Name: '' }] }, indexById)).toEqual([]);
  });
});

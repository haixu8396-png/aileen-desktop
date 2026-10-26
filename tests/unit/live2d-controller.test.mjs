import { describe, it, expect } from 'vitest';
import { createLive2DController, hotkeySupported } from '../../src/lib/live2d/controller.js';

// ---------- 替身 ----------
/** 假 coreModel：ById 接口是坏的（写进幻影表），只有 ByIndex 真的改参数 —— 和真引擎一样 */
function makeCoreModel({ params = [], parts = [] } = {}) {
  const state = {
    values: params.map((p) => (p.def !== undefined ? p.def : 0)),
    opacities: parts.map((p) => (p.opacity !== undefined ? p.opacity : 1)),
    phantom: new Map(),
    byIdWrites: 0,
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
    setParameterValueByIndex: (i, v) => { state.values[i] = v; },
    getParameterValueById: () => -1,
    setParameterValueById: () => { state.byIdWrites += 1; },
    getParameterIndex: () => -1,
    getPartCount: () => parts.length,
    getPartId: (i) => partIds[i],
    getPartOpacityByIndex: (i) => state.opacities[i],
    setPartOpacityByIndex: (i, v) => { state.opacities[i] = v; },
  };
}

const PARAMS = [
  { id: 'SchoolUniform', min: 0, max: 1, def: 0 },
  { id: 'ParamAngleX', min: -30, max: 30, def: 0 },
  { id: 'ParamMouthOpenY', min: 0, max: 1, def: 0 },
];
const PARTS = [
  { id: 'Part64', opacity: 1 },
  { id: 'Part11', opacity: 0.6 },
];

const URL_1 = 'http://127.0.0.1:1/models/m1/m1.model3.json';
const BASE_1 = 'http://127.0.0.1:1/models/m1/m1';
const DIR_1 = 'http://127.0.0.1:1/models/m1/';
const URL_2 = 'http://127.0.0.1:1/models/m2/m2.model3.json';
const BASE_2 = 'http://127.0.0.1:1/models/m2/m2';

function makeStorage() {
  const data = new Map();
  // 照真 localStorage 实现：迁移老存档要靠 length / key(i) 枚举键
  return {
    data,
    get length() { return data.size; },
    key: (i) => (i >= 0 && i < data.size ? [...data.keys()][i] : null),
    getItem: (k) => (data.has(String(k)) ? data.get(String(k)) : null),
    setItem: (k, v) => { data.set(String(k), String(v)); },
    removeItem: (k) => { data.delete(String(k)); },
  };
}

function makeNet(files) {
  // 端口不敏感：真实环境里本地静态服务每次启动随机端口，
  // 配置文件的「同一条路径」在不同端口下都要能取到
  const normalize = (u) => String(u).replace(/127\.0\.0\.1:\d+/, '127.0.0.1:1');
  const table = new Map();
  for (const [k, v] of Object.entries(files)) table.set(normalize(k), v);
  const net = {
    files: table,
    hits: [],
    async get(url) {
      net.hits.push(url);
      const k = normalize(url);
      return table.has(k) ? table.get(k) : null;
    },
  };
  return net;
}

const VTUBE_1 = {
  Hotkeys: [
    { Name: '校服', Action: 'ToggleExpression', File: '校服.exp3.json' },
    { Name: '笑脸', Action: 'ToggleExpression', File: '笑脸.exp3.json' },
    { Name: '坏文件', Action: 'ToggleExpression', File: '坏.exp3.json' },
    { Name: '穿越', Action: 'ToggleExpression', File: '../../etc/passwd.exp3.json' },
    { Name: '换姿势', Action: 'MoveModel', File: 'a.json' },
  ],
};
const CDI3_1 = {
  Parts: [
    { Id: 'Part64', Name: '衣服.psd' },
    { Id: 'Part11', Name: '裙子.psd' },
    { Id: 'Part99', Name: '不存在.psd' },
  ],
};

function makeController(over = {}) {
  const files = Object.assign({
    [BASE_1 + '.vtube.json']: VTUBE_1,
    [BASE_1 + '.cdi3.json']: CDI3_1,
    [DIR_1 + '校服.exp3.json']: { Parameters: [{ Id: 'SchoolUniform', Value: 1, Blend: 'Overwrite' }] },
    [DIR_1 + '笑脸.exp3.json']: { Parameters: [{ Id: 'ParamAngleX', Value: 10, Blend: 'Add' }] },
    // 坏.exp3.json 故意不存在 → 读不到
  }, over);
  const net = makeNet({});
  for (const [k, v] of Object.entries(files)) if (v !== undefined) net.files.set(k, v);
  const storage = makeStorage();
  const ctl = createLive2DController({ fetchJson: net.get, storage });
  return { ctl, net, storage };
}

// ---------- 测试 ----------
describe('controller：挂模型', () => {
  it('建表 + 读 vtube/cdi3，热键与部件都对上运行时下标', async () => {
    const { ctl } = makeController();
    const cm = makeCoreModel({ params: PARAMS, parts: PARTS });
    const r = await ctl.load({ url: URL_1 }, cm);
    expect(r.hotkeys).toBe(4);                    // 5 条里 1 条 MoveModel 不支持
    expect(r.parts).toBe(2);                      // Part99 运行时没有
    expect(ctl.paramTable.count).toBe(3);
    expect(ctl.hotkeys.find((h) => h.name === '校服').file).toBe('校服.exp3.json');
    expect(ctl.unsupported.map((u) => u.name)).toEqual(['换姿势']);
    expect(ctl.parts.map((p) => p.label)).toEqual(['衣服', '裙子']);
    expect(ctl.parts[1].index).toBe(1);
    expect(ctl.errors).toEqual([]);
  });

  it('没有 .vtube.json 的模型：0 个热键，但不是错误', async () => {
    const { ctl } = makeController({ [BASE_1 + '.vtube.json']: undefined });
    const cm = makeCoreModel({ params: PARAMS, parts: PARTS });
    const r = await ctl.load({ url: URL_1 }, cm);
    expect(r.hotkeys).toBe(0);
    expect(ctl.hotkeys).toEqual([]);
    expect(ctl.errors).toEqual([]);               // 「没有热键表」不该报错
  });

  it('没有模型时干净复位，不残留上一个模型的表', async () => {
    const { ctl } = makeController();
    const cm = makeCoreModel({ params: PARAMS, parts: PARTS });
    await ctl.load({ url: URL_1 }, cm);
    await ctl.load(null, null);
    expect(ctl.paramTable.count).toBe(0);
    expect(ctl.hotkeys).toEqual([]);
    expect(ctl.parts).toEqual([]);
  });
});

describe('controller：表达式（真的写进模型）', () => {
  it('打开 → 参数变成表达式值；关闭 → 回到基线', async () => {
    const { ctl } = makeController();
    const cm = makeCoreModel({ params: PARAMS, parts: PARTS });
    await ctl.load({ url: URL_1 }, cm);
    const hk = ctl.hotkeys.find((h) => h.name === '校服');
    expect(cm.state.values[0]).toBe(0);           // 基线

    const r = await ctl.setHotkeyActive(hk, true);
    expect(r.ok).toBe(true);
    ctl.apply(cm);
    expect(cm.state.values[0]).toBe(1);           // 真的写进去了

    const off = await ctl.setHotkeyActive(hk, false);
    expect(off.ok).toBe(true);
    expect(cm.state.values[0]).toBe(0);           // 还原成基线，不是「写 0」
    expect(cm.state.byIdWrites).toBe(0);          // 全程没碰引擎那个坏接口
  });

  it('多个表达式同时开：Overwrite 之后 Add 在同一参数上继续叠加', async () => {
    const { ctl } = makeController();
    const cm = makeCoreModel({ params: PARAMS, parts: PARTS });
    await ctl.load({ url: URL_1 }, cm);
    const a = ctl.hotkeys.find((h) => h.name === '校服');
    const b = ctl.hotkeys.find((h) => h.name === '笑脸');
    await ctl.setHotkeyActive(a, true);
    await ctl.setHotkeyActive(b, true);
    ctl.apply(cm);
    expect(cm.state.values[1]).toBe(10);         // ParamAngleX 0 + 10
    ctl.clearHotkeys();
    expect(cm.state.values[0]).toBe(0);
    expect(cm.state.values[1]).toBe(0);
  });

  it('参数不在模型里 → ok=false + missing 列表，热键上记着原因（假成功是不允许的）', async () => {
    const { ctl } = makeController({
      [DIR_1 + '校服.exp3.json']: { Parameters: [{ Id: 'NoSuchParam', Value: 1 }] },
    });
    const cm = makeCoreModel({ params: PARAMS, parts: PARTS });
    await ctl.load({ url: URL_1 }, cm);
    const hk = ctl.hotkeys.find((h) => h.name === '校服');
    const r = await ctl.setHotkeyActive(hk, true);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['NoSuchParam']);
    expect(hk.error).toMatch(/NoSuchParam/);
    ctl.apply(cm);
    expect(cm.state.values[0]).toBe(0);           // 一个参数都没写
  });

  it('表达式文件不存在 → ok=false 并说明原因', async () => {
    const { ctl } = makeController();
    const cm = makeCoreModel({ params: PARAMS, parts: PARTS });
    await ctl.load({ url: URL_1 }, cm);
    const hk = ctl.hotkeys.find((h) => h.name === '坏文件');
    const r = await ctl.setHotkeyActive(hk, true);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/读取失败/);
    expect(ctl.active.has('坏.exp3.json')).toBe(false);
  });

  it('路径穿越的表达式直接拒绝，不去 fetch', async () => {
    const { ctl, net } = makeController();
    const cm = makeCoreModel({ params: PARAMS, parts: PARTS });
    await ctl.load({ url: URL_1 }, cm);
    const hk = ctl.hotkeys.find((h) => h.name === '穿越');
    const before = net.hits.length;
    const r = await ctl.setHotkeyActive(hk, true);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/路径非法/);
    expect(net.hits.length).toBe(before);         // 一次网络请求都没发
  });

  it('不支持的 VTS 动作不能激活', async () => {
    const { ctl } = makeController();
    const cm = makeCoreModel({ params: PARAMS, parts: PARTS });
    await ctl.load({ url: URL_1 }, cm);
    const r = await ctl.setHotkeyActive({ supported: false, reason: '暂不支持' }, true);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('暂不支持');
    expect(hotkeySupported('ToggleExpression')).toBe(true);
    expect(hotkeySupported('MoveModel')).toBe(false);
  });

  it('Add 在「动作/物理改过参数」的下一帧不会越叠越大', async () => {
    const { ctl } = makeController();
    const cm = makeCoreModel({ params: PARAMS, parts: PARTS });
    await ctl.load({ url: URL_1 }, cm);
    const hk = ctl.hotkeys.find((h) => h.name === '笑脸');   // ParamAngleX +10
    await ctl.setHotkeyActive(hk, true);

    ctl.apply(cm);
    expect(cm.state.values[1]).toBe(10);
    ctl.apply(cm);                                  // 没人动过：稳定在 10
    expect(cm.state.values[1]).toBe(10);

    cm.state.values[1] = 20;                        // 模拟动作把参数改成 20
    ctl.apply(cm);
    expect(cm.state.values[1]).toBe(30);            // 20 + 10，而不是 10 + 10
  });
});

describe('controller：部件', () => {
  it('隐藏记下原始不透明度，恢复写回原值（不是一律 1）', async () => {
    const { ctl } = makeController();
    const cm = makeCoreModel({ params: PARAMS, parts: PARTS });
    await ctl.load({ url: URL_1 }, cm);
    const skirt = ctl.parts.find((p) => p.name === '裙子');
    const r = ctl.hidePart(skirt);
    expect(r.ok).toBe(true);
    expect(r.original).toBe(0.6);
    expect(cm.state.opacities[1]).toBe(0);
    ctl.apply(cm);                                  // 每帧重申
    expect(cm.state.opacities[1]).toBe(0);
    ctl.showPart(skirt);
    expect(cm.state.opacities[1]).toBe(0.6);         // 回到原始值
    expect(ctl.isPartHidden(skirt.id)).toBe(false);
  });

  it('全部显示：每个被隐藏的部件都还原', async () => {
    const { ctl } = makeController();
    const cm = makeCoreModel({ params: PARAMS, parts: PARTS });
    await ctl.load({ url: URL_1 }, cm);
    ctl.hidePart(ctl.parts[0]);
    ctl.hidePart(ctl.parts[1]);
    expect(cm.state.opacities).toEqual([0, 0]);
    expect(ctl.showAllParts()).toBe(2);
    expect(cm.state.opacities).toEqual([1, 0.6]);
    expect([...ctl.hiddenParts.keys()]).toEqual([]);
  });
});

describe('controller：状态持久化', () => {
  it('按模型分开存；重新 load 会真的恢复（参数与部件都回来）', async () => {
    const { ctl, storage } = makeController();
    const cm = makeCoreModel({ params: PARAMS, parts: PARTS });
    await ctl.load({ url: URL_1 }, cm);
    await ctl.setHotkeyActive(ctl.hotkeys.find((h) => h.name === '校服'), true);
    ctl.hidePart(ctl.parts[0]);
    const raw = storage.getItem('aileen.live2d.v2.' + URL_1);
    expect(raw).toBeTruthy();
    const saved = JSON.parse(raw);
    expect(saved.version).toBe(2);
    expect(saved.activeExpressions).toEqual(['校服.exp3.json']);
    expect(saved.hiddenParts).toEqual(['Part64']);

    // 新控制器（= 应用重启）用同一份 storage 和同一份网络：状态必须真的回到模型上
    const net2 = makeNet({
      [BASE_1 + '.vtube.json']: VTUBE_1,
      [BASE_1 + '.cdi3.json']: CDI3_1,
      [DIR_1 + '校服.exp3.json']: { Parameters: [{ Id: 'SchoolUniform', Value: 1, Blend: 'Overwrite' }] },
    });
    const ctl2 = createLive2DController({ fetchJson: net2.get, storage });
    const cm2 = makeCoreModel({ params: PARAMS, parts: PARTS });
    const r = await ctl2.load({ url: URL_1 }, cm2);
    expect(r.restored).toEqual({ expressions: 1, parts: 1 });
    ctl2.apply(cm2);
    expect(cm2.state.values[0]).toBe(1);
    expect(cm2.state.opacities[0]).toBe(0);
  });

  it('旧版本的键（aileen.hotkeys.* / aileen.parts.*）能迁移过来', async () => {
    const storage = makeStorage();
    storage.setItem('aileen.hotkeys.' + URL_1, JSON.stringify(['校服.exp3.json']));
    storage.setItem('aileen.parts.' + URL_1, JSON.stringify(['Part64']));
    const net = makeNet({
      [BASE_1 + '.vtube.json']: VTUBE_1,
      [BASE_1 + '.cdi3.json']: CDI3_1,
      [DIR_1 + '校服.exp3.json']: { Parameters: [{ Id: 'SchoolUniform', Value: 1 }] },
    });
    const ctl = createLive2DController({ fetchJson: net.get, storage });
    const cm = makeCoreModel({ params: PARAMS, parts: PARTS });
    const r = await ctl.load({ url: URL_1 }, cm);
    expect(r.restored).toEqual({ expressions: 1, parts: 1 });
  });

  it('坏掉的存档当没存过，不炸', async () => {
    const storage = makeStorage();
    storage.setItem('aileen.live2d.v2.' + URL_1, '{不是 JSON');
    const net = makeNet({ [BASE_1 + '.vtube.json']: VTUBE_1, [BASE_1 + '.cdi3.json']: CDI3_1 });
    const ctl = createLive2DController({ fetchJson: net.get, storage });
    await ctl.load({ url: URL_1 }, makeCoreModel({ params: PARAMS, parts: PARTS }));
    expect(ctl.active.size).toBe(0);
    expect(ctl.hiddenParts.size).toBe(0);
  });

  it('存档键用稳定标识（相对 models/ 的路径），不带端口', async () => {
    const { ctl, storage } = makeController();
    const cm = makeCoreModel({ params: PARAMS, parts: PARTS });
    await ctl.load({ url: URL_1, key: 'm1/m1.model3.json' }, cm);
    await ctl.setHotkeyActive(ctl.hotkeys.find((h) => h.name === '校服'), true);
    ctl.hidePart(ctl.parts[0]);
    const keys = [...storage.data.keys()];
    expect(keys).toEqual(['aileen.live2d.v2.m1/m1.model3.json']);
    expect(keys[0]).not.toMatch(/:\d+\//);
    expect(JSON.parse(storage.getItem(keys[0])).activeExpressions).toEqual(['校服.exp3.json']);
  });

  it('换端口重开（同一个模型）也能读回上一次的热键/部件状态', async () => {
    const files = {
      [BASE_1 + '.vtube.json']: VTUBE_1,
      [BASE_1 + '.cdi3.json']: CDI3_1,
      [DIR_1 + '校服.exp3.json']: { Parameters: [{ Id: 'SchoolUniform', Value: 1 }] },
    };
    const storage = makeStorage();
    const net = makeNet(files);
    const modelA = { url: URL_1, key: 'm1/m1.model3.json' };
    const ctlA = createLive2DController({ fetchJson: net.get, storage });
    await ctlA.load(modelA, makeCoreModel({ params: PARAMS, parts: PARTS }));
    await ctlA.setHotkeyActive(ctlA.hotkeys.find((h) => h.name === '校服'), true);
    ctlA.hidePart(ctlA.parts[0]);

    // 模拟下次启动：URL 换了端口（key 不变），新的控制器实例
    const urlB = URL_1.replace('127.0.0.1:1', '127.0.0.1:50999');
    const ctlB = createLive2DController({ fetchJson: net.get, storage });
    const cmB = makeCoreModel({ params: PARAMS, parts: PARTS });
    const r = await ctlB.load({ url: urlB, key: 'm1/m1.model3.json' }, cmB);
    expect(r.restored).toEqual({ expressions: 1, parts: 1 });
    ctlB.apply(cmB);
    expect(cmB.state.values[0]).toBe(1);
    expect(cmB.state.opacities[0]).toBe(0);
  });

  it('带随机端口的老存档（0.7.6 之前）能迁移到新键，且老键被清掉', async () => {
    const storage = makeStorage();
    // 老格式：整个 URL 当键（端口 55048），同一个模型
    storage.setItem('aileen.live2d.v2.http://127.0.0.1:55048/models/m1/m1.model3.json', JSON.stringify({
      version: 2,
      activeExpressions: ['校服.exp3.json'],
      hiddenParts: ['Part64'],
    }));
    // 另一个模型的存档不能跟着串味
    storage.setItem('aileen.live2d.v2.http://127.0.0.1:55048/models/m2/m2.model3.json', JSON.stringify({
      version: 2, activeExpressions: ['m2.exp3.json'], hiddenParts: [],
    }));
    const net = makeNet({
      [BASE_1 + '.vtube.json']: VTUBE_1,
      [BASE_1 + '.cdi3.json']: CDI3_1,
      [DIR_1 + '校服.exp3.json']: { Parameters: [{ Id: 'SchoolUniform', Value: 1 }] },
    });
    const ctl = createLive2DController({ fetchJson: net.get, storage });
    const cm = makeCoreModel({ params: PARAMS, parts: PARTS });
    const r = await ctl.load({ url: URL_1, key: 'm1/m1.model3.json' }, cm);
    expect(r.restored).toEqual({ expressions: 1, parts: 1 });
    expect(ctl.active.has('校服.exp3.json')).toBe(true);
    expect(ctl.isPartHidden('Part64')).toBe(true);
    // 迁移完：老键删掉、新键写好了、别的模型的键没被动
    expect(storage.getItem('aileen.live2d.v2.http://127.0.0.1:55048/models/m1/m1.model3.json')).toBe(null);
    expect(storage.getItem('aileen.live2d.v2.m1/m1.model3.json')).toBeTruthy();
    expect(storage.getItem('aileen.live2d.v2.http://127.0.0.1:55048/models/m2/m2.model3.json')).toBeTruthy();
  });

  it('状态落盘走主进程（durable）：localStorage 丢了也能恢复', async () => {
    // 模拟「上次强杀没写盘」：localStorage 空的，但主进程设置文件里有
    const storage = makeStorage();
    const savedRemote = {};
    const persist = {
      load: async (id) => savedRemote[id] || null,
      save: async (id, state) => { savedRemote[id] = Object.assign({}, state); return true; },
    };
    const net = makeNet({
      [BASE_1 + '.vtube.json']: VTUBE_1,
      [BASE_1 + '.cdi3.json']: CDI3_1,
      [DIR_1 + '校服.exp3.json']: { Parameters: [{ Id: 'SchoolUniform', Value: 1 }] },
    });
    const model = { url: URL_1, key: 'm1/m1.model3.json' };

    // 第一次：打开热键 → 写入 durable（localStorage 内容随后被"丢掉"）
    const ctlA = createLive2DController({ fetchJson: net.get, storage, persist });
    await ctlA.load(model, makeCoreModel({ params: PARAMS, parts: PARTS }));
    await ctlA.setHotkeyActive(ctlA.hotkeys.find((h) => h.name === '校服'), true);
    expect(savedRemote['m1/m1.model3.json'].activeExpressions).toEqual(['校服.exp3.json']);
    storage.data.clear();

    // 第二次（= 强杀后重开）：localStorage 空，只能靠 durable
    const ctlB = createLive2DController({ fetchJson: net.get, storage, persist });
    const cmB = makeCoreModel({ params: PARAMS, parts: PARTS });
    const r = await ctlB.load(model, cmB);
    expect(r.restored.expressions).toBe(1);
    ctlB.apply(cmB);
    expect(cmB.state.values[0]).toBe(1);
  });

  it('切换模型：激活与隐藏记录不串味，旧模型的配置缓存清空', async () => {
    const net = makeNet({
      [BASE_1 + '.vtube.json']: VTUBE_1,
      [BASE_1 + '.cdi3.json']: CDI3_1,
      [DIR_1 + '校服.exp3.json']: { Parameters: [{ Id: 'SchoolUniform', Value: 1 }] },
      [BASE_2 + '.vtube.json']: { Hotkeys: [] },
      [BASE_2 + '.cdi3.json']: { Parts: [] },
    });
    const storage = makeStorage();
    const ctl = createLive2DController({ fetchJson: net.get, storage });
    const cm = makeCoreModel({ params: PARAMS, parts: PARTS });
    await ctl.load({ url: URL_1 }, cm);
    await ctl.setHotkeyActive(ctl.hotkeys.find((h) => h.name === '校服'), true);
    ctl.hidePart(ctl.parts[0]);
    expect(ctl.active.size).toBe(1);

    await ctl.load({ url: URL_2 }, cm);
    expect(ctl.active.size).toBe(0);
    expect(ctl.hiddenParts.size).toBe(0);
    expect(ctl.expressionCache.size).toBe(0);
    expect(ctl.parts).toEqual([]);
    // 旧模型的状态还在它自己的键里，没被覆盖
    expect(JSON.parse(storage.getItem('aileen.live2d.v2.' + URL_1)).activeExpressions).toEqual(['校服.exp3.json']);
  });
});

describe('controller：异步竞态', () => {
  it('旧模型的加载结果不会盖到新模型上', async () => {
    let releaseFirst;
    const firstGate = new Promise((res) => { releaseFirst = res; });
    const storage = makeStorage();
    const ctl = createLive2DController({
      storage,
      fetchJson: async (url) => {
        if (url === BASE_1 + '.vtube.json') { await firstGate; return VTUBE_1; }
        if (url === BASE_1 + '.cdi3.json') return CDI3_1;
        if (url === BASE_2 + '.vtube.json') return { Hotkeys: [] };
        if (url === BASE_2 + '.cdi3.json') return { Parts: [] };
        return null;
      },
    });
    const cm = makeCoreModel({ params: PARAMS, parts: PARTS });
    const p1 = ctl.load({ url: URL_1 }, cm);
    const p2 = ctl.load({ url: URL_2 }, cm);
    const r2 = await p2;
    expect(r2.hotkeys).toBe(0);
    releaseFirst();
    const r1 = await p1;
    expect(r1.stale).toBe(true);
    expect(ctl.modelUrl).toBe(URL_2);          // 还是新模型
    expect(ctl.hotkeys).toEqual([]);            // 旧模型的热键没塞进来
  });

  it('读表达式期间换了模型：这次激活作废', async () => {
    let releaseExp;
    const expGate = new Promise((res) => { releaseExp = res; });
    const storage = makeStorage();
    let phase = 1;
    const ctl = createLive2DController({
      storage,
      fetchJson: async (url) => {
        if (url === BASE_1 + '.vtube.json') return VTUBE_1;
        if (url === BASE_1 + '.cdi3.json') return CDI3_1;
        if (url === DIR_1 + '校服.exp3.json') { await expGate; return { Parameters: [{ Id: 'SchoolUniform', Value: 1 }] }; }
        if (url === BASE_2 + '.vtube.json' || url === BASE_2 + '.cdi3.json') return {};
        return null;
      },
    });
    const cm = makeCoreModel({ params: PARAMS, parts: PARTS });
    await ctl.load({ url: URL_1 }, cm);
    const hk = ctl.hotkeys.find((h) => h.name === '校服');
    const pending = ctl.setHotkeyActive(hk, true);
    ctl.modelUrl = URL_2;                       // 等价于「这期间换模型了」
    phase = 2;
    releaseExp();
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/模型已切换/);
    expect(phase).toBe(2);
  });
});

describe('controller：快照与错误', () => {
  it('snapshot 只给纯数据，自检读得出来', async () => {
    const { ctl } = makeController();
    const cm = makeCoreModel({ params: PARAMS, parts: PARTS });
    await ctl.load({ url: URL_1 }, cm);
    await ctl.setHotkeyActive(ctl.hotkeys.find((h) => h.name === '校服'), true);
    ctl.hidePart(ctl.parts[1]);
    const s = ctl.snapshot();
    expect(s.params).toBe(3);
    expect(s.active).toEqual(['校服.exp3.json']);
    expect(s.hiddenParts).toEqual([{ id: 'Part11', index: 1, original: 0.6 }]);
    expect(s.unsupported).toEqual([{ name: '换姿势', action: 'MoveModel', reason: expect.any(String) }]);
    expect(JSON.stringify(s)).toBeTruthy();      // 能序列化（不含引擎对象）
  });

  it('失败会写进 errors，且不会无限增长', async () => {
    const { ctl } = makeController();
    const cm = makeCoreModel({ params: PARAMS, parts: PARTS });
    await ctl.load({ url: URL_1 }, cm);
    const hk = ctl.hotkeys.find((h) => h.name === '坏文件');
    for (let i = 0; i < 60; i += 1) await ctl.setHotkeyActive(hk, true);
    expect(ctl.errors.length).toBeLessThanOrEqual(40);
    expect(ctl.errors.every((e) => typeof e.message === 'string')).toBe(true);
  });

  it('没有 localStorage 的环境（隐私模式）不炸', async () => {
    const net = makeNet({ [BASE_1 + '.vtube.json']: VTUBE_1, [BASE_1 + '.cdi3.json']: CDI3_1 });
    const ctl = createLive2DController({ fetchJson: net.get, storage: null });
    const cm = makeCoreModel({ params: PARAMS, parts: PARTS });
    await ctl.load({ url: URL_1 }, cm);
    expect(ctl.saveState()).toBe(false);
    await expect(ctl.readState()).resolves.toEqual({ activeExpressions: [], hiddenParts: [] });
  });
});

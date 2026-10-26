import { describe, it, expect } from 'vitest';
import util from '../../shared/util.cjs';

const { deepMerge, sanitizeFileName, normalizeSettings, isInsidePath } = util;

describe('设置归一化：模型类型的默认值', () => {
  it('除 LLM 外，语音合成 / 识别 / 嵌入模型默认都是「（无）」', () => {
    const s = normalizeSettings({}, {});
    expect(s.tts.provider).toBe('none');
    expect(s.stt.provider).toBe('none');
    expect(s.embedding.provider).toBe('none');
    // LLM 不能是 none：对话必须有模型
    expect(s.llm.provider).not.toBe('none');
  });

  it('显式选 none 会保留；乱填的值退回 none', () => {
    expect(normalizeSettings({ tts: { provider: 'none' } }, {}).tts.provider).toBe('none');
    expect(normalizeSettings({ stt: { provider: 'none' } }, {}).stt.provider).toBe('none');
    expect(normalizeSettings({ embedding: { provider: 'none' } }, {}).embedding.provider).toBe('none');
    expect(normalizeSettings({ tts: { provider: 'bogus' } }, {}).tts.provider).toBe('none');
  });

  it('时间感知默认开，关掉能记住', () => {
    expect(normalizeSettings({}, {}).general.timeAwareness).toBe(true);
    expect(normalizeSettings({ general: { timeAwareness: false } }, {}).general.timeAwareness).toBe(false);
  });
});

describe('设置归一化：Live2D 状态存档', () => {
  it('只保留字符串数组，坏数据丢掉但整体不炸', () => {
    const s = normalizeSettings({ live2dState: { byModel: { 'a/b.model3.json': { activeExpressions: ['x.exp3.json', 3, null], hiddenParts: ['Part1'] } } } }, {});
    expect(s.live2dState.byModel['a/b.model3.json'].activeExpressions).toEqual(['x.exp3.json']);
    expect(s.live2dState.byModel['a/b.model3.json'].hiddenParts).toEqual(['Part1']);
  });

  it('模型数量有上限（设置文件不会被撑爆）', () => {
    const byModel = {};
    for (let i = 0; i < 80; i += 1) byModel['m' + i + '/m.model3.json'] = { activeExpressions: [], hiddenParts: [], updatedAt: i };
    const s = normalizeSettings({ live2dState: { byModel } }, {});
    expect(Object.keys(s.live2dState.byModel).length).toBeLessThanOrEqual(50);
    // 保留最近的（updatedAt 大的）
    expect(s.live2dState.byModel['m79/m.model3.json']).toBeTruthy();
  });
});

describe('deepMerge', () => {
  it('递归合并对象、数组整体替换', () => {
    const a = { x: { y: 1, z: 2 }, list: [1, 2, 3] };
    const b = { x: { z: 9 }, list: [4] };
    expect(deepMerge(a, b)).toEqual({ x: { y: 1, z: 9 }, list: [4] });
  });
  it('不修改原对象', () => {
    const a = { x: { y: 1 } };
    deepMerge(a, { x: { y: 2 } });
    expect(a.x.y).toBe(1);
  });
});

describe('sanitizeFileName', () => {
  it('保留中文', () => {
    expect(sanitizeFileName('星野空')).toBe('星野空');
  });
  it('保留日文假名（回归：アトリ 不应变成下划线）', () => {
    expect(sanitizeFileName('アトリ')).toBe('アトリ');
    expect(sanitizeFileName('ミカ・テスト')).toBe('ミカ_テスト');
  });
  it('替换路径分隔符与危险字符', () => {
    expect(sanitizeFileName('../../etc/passwd')).not.toContain('/');
    expect(sanitizeFileName('a\\b')).toBe('a_b');
    expect(sanitizeFileName('  ..  ')).toBe('character');
  });
  it('空值回退', () => {
    expect(sanitizeFileName('')).toBe('character');
    expect(sanitizeFileName(null)).toBe('character');
    expect(sanitizeFileName('', 'x')).toBe('x');
  });
});

describe('isInsidePath', () => {
  it('识别子路径与越界路径', () => {
    expect(isInsidePath('D:/data/chats/a.json', 'D:/data')).toBe(true);
    expect(isInsidePath('D:/data-other/a.json', 'D:/data')).toBe(false);
    expect(isInsidePath('D:/data', 'D:/data')).toBe(true);
    expect(isInsidePath('', 'D:/data')).toBe(false);
  });
});

describe('normalizeSettings', () => {
  it('丢弃未知字段、越界数值收敛', () => {
    const out = normalizeSettings({
      llm: { provider: 'deepseek', temperature: 999, maxTokens: 999999, evil: 'x' },
      hacked: true,
    });
    expect(out.llm.temperature).toBe(2);
    expect(out.llm.maxTokens).toBe(8192);
    expect(out.llm.evil).toBeUndefined();
    expect(out.hacked).toBeUndefined();
  });
  it('非法 URL 与非 http(s) 地址被清空', () => {
    const out = normalizeSettings({ llm: { baseUrl: 'javascript:alert(1)' }, tts: { baseUrl: 'file:///etc/passwd' } });
    expect(out.llm.baseUrl).toBe('');
    expect(out.tts.baseUrl).toBe('');
  });
  it('extraModels 过滤非法项并整体替换', () => {
    const out = normalizeSettings({ extraModels: [{ name: 'a', url: 'https://x/a.json' }, { name: 'bad', url: 'javascript:1' }] });
    expect(out.extraModels).toHaveLength(1);
    expect(out.extraModels[0].url).toBe('https://x/a.json');
  });
  it('主题色校验', () => {
    expect(normalizeSettings({ theme: { primary: 'red' } }).theme.primary).toBe('#ff7eb3');
    expect(normalizeSettings({ theme: { primary: '#123456' } }).theme.primary).toBe('#123456');
  });
});

describe('normalizeSettings · 无边框悬浮展台', () => {
  it('缺省时给安全默认值：不自动显示、默认鼠标穿透', () => {
    const o = normalizeSettings({}).overlay;
    expect(o.visible).toBe(false);
    expect(o.interactive).toBe(false);
    expect(o.x).toBeNull();
    expect(o.y).toBeNull();
    expect(o.width).toBe(380);
    expect(o.height).toBe(640);
    expect(o.opacity).toBe(1);
  });
  it('坐标非法时回落到 null（下次自动摆到右下角）', () => {
    const o = normalizeSettings({ overlay: { x: 'abc', y: NaN } }).overlay;
    expect(o.x).toBeNull();
    expect(o.y).toBeNull();
  });
  it('越界的尺寸/透明度/缩放被收敛而不是崩溃', () => {
    const o = normalizeSettings({ overlay: { width: 99999, height: 1, opacity: 99, scale: -5 } }).overlay;
    expect(o.width).toBe(1400);
    expect(o.height).toBe(220);
    expect(o.opacity).toBe(1);
    expect(o.scale).toBe(0.1);
  });
  it('未知字段被丢弃、合法开关被保留', () => {
    expect(normalizeSettings({ overlay: { evil: 1, visible: true } }).overlay.evil).toBeUndefined();
    expect(normalizeSettings({ overlay: { visible: true, interactive: true } }).overlay.visible).toBe(true);
    expect(normalizeSettings({ overlay: { interactive: true } }).overlay.interactive).toBe(true);
  });
});

describe('normalizeSettings · Live2D 精细控制', () => {
  it('缺省时给出一整套可用的默认值（展台渲染层直接读它）', () => {
    const l = normalizeSettings({}).live2d;
    expect(l.fit).toBe(0.95);
    expect(l.zoom).toBe(1);
    expect(l.offsetY).toBe(0);
    expect(l.lipsync).toBe(true);
    expect(l.lipsyncGain).toBe(1.2);
    expect(l.idleMotion).toBe(true);
    expect(l.idleInterval).toBe(14);
    expect(l.focusFollow).toBe(true);
    expect(l.physics).toBe(true);
    expect(l.quality).toBe('auto');
    expect(l.fps).toBe(60);
    expect(l.lod).toBe('auto');
    expect(l.mask).toBe('auto');
  });
  it('越界数值被收敛（占比不能无限大、帧率不能为 0）', () => {
    const l = normalizeSettings({ live2d: { fit: 99, zoom: 0, offsetY: -9, lipsyncGain: 999, idleInterval: 0, fps: 1 } }).live2d;
    expect(l.fit).toBe(1.15);
    expect(l.zoom).toBe(0.4);
    expect(l.offsetY).toBe(-0.3);
    expect(l.lipsyncGain).toBe(3);
    expect(l.idleInterval).toBe(3);
    expect(l.fps).toBe(15);
  });
  it('枚举字段只接受白名单值，未知值回落到默认', () => {
    const l = normalizeSettings({ live2d: { quality: '8x', lod: 'max', mask: 'ultra' } }).live2d;
    expect(l.quality).toBe('auto');
    expect(l.lod).toBe('auto');
    expect(l.mask).toBe('auto');
    expect(normalizeSettings({ live2d: { quality: '2', lod: 'off', mask: 'high' } }).live2d.quality).toBe('2');
  });
  it('未知字段被丢弃、开关只认布尔值', () => {
    const l = normalizeSettings({ live2d: { evil: 1, lipsync: 'yes', physics: false } }).live2d;
    expect(l.evil).toBeUndefined();
    expect(l.lipsync).toBe(true); // 非布尔 → 回落默认值（不是字符串 'yes'）
    expect(l.physics).toBe(false);
  });
});

describe('normalizeSettings · Minecraft 伙伴', () => {
  it('缺省时给安全默认值', () => {
    const m = normalizeSettings({}).mc;
    expect(m.host).toBe('');
    expect(m.port).toBe(25565);
    expect(m.username).toBe('AILEEN');
    expect(m.autoReply).toBe(false);
  });
  it('端口越界收敛、角色名截断到 16 字符', () => {
    expect(normalizeSettings({ mc: { port: 999999 } }).mc.port).toBe(65535);
    expect(normalizeSettings({ mc: { port: 0 } }).mc.port).toBe(1);
    expect(normalizeSettings({ mc: { username: 'abcdefghijklmnopqrstuvwxyz' } }).mc.username).toBe('abcdefghijklmnop');
  });
  it('未知字段被丢弃', () => {
    expect(normalizeSettings({ mc: { evil: 'rm -rf', autoReply: true } }).mc.evil).toBeUndefined();
    expect(normalizeSettings({ mc: { autoReply: true } }).mc.autoReply).toBe(true);
  });
});

describe('normalizeSettings · 界面语言', () => {
  it('默认简体中文，非法值回退中文', () => {
    expect(normalizeSettings({}).language).toBe('zh');
    expect(normalizeSettings({ language: 'fr' }).language).toBe('zh');
    expect(normalizeSettings({ language: 42 }).language).toBe('zh');
  });
  it('接受 ja / zh', () => {
    expect(normalizeSettings({ language: 'ja' }).language).toBe('ja');
    expect(normalizeSettings({ language: 'zh' }).language).toBe('zh');
  });
});

describe('normalizeSettings · 国际象棋', () => {
  it('缺省时给安全默认值', () => {
    const c = normalizeSettings({}).chess;
    expect(c.level).toBe(3);
    expect(c.playerColor).toBe('white');
    expect(c.banter).toBe(false);
    expect(c.fenStack).toEqual([]);
  });
  it('等级越界收敛、执子颜色非法回退', () => {
    expect(normalizeSettings({ chess: { level: 99 } }).chess.level).toBe(5);
    expect(normalizeSettings({ chess: { level: 0 } }).chess.level).toBe(1);
    expect(normalizeSettings({ chess: { playerColor: 'green' } }).chess.playerColor).toBe('white');
    expect(normalizeSettings({ chess: { playerColor: 'black' } }).chess.playerColor).toBe('black');
  });
  it('fenStack 过滤非法项并限制长度', () => {
    const c = normalizeSettings({ chess: { fenStack: ['abc', 123, null, 'd'.repeat(200), 'ok'] } }).chess;
    expect(c.fenStack).toEqual(['abc', 'ok']);
    const many = Array.from({ length: 400 }, () => 'x');
    expect(normalizeSettings({ chess: { fenStack: many } }).chess.fenStack.length).toBe(200);
  });
});

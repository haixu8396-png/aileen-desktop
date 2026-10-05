// ============================================================
// IPC 载荷契约：**渲染层真正发出去的东西**必须过得了参数校验。
//
// 这一层存在的意义是「字段名对不上就静默失效」——参数校验会拒掉调用，但界面不会
// 报错，只是功能悄悄不工作。2026-10-06 就踩了两次：
//   · overlay:hitArea 的 schema 写成 { width, height }，而 overlay.js 发的是
//     { w, h } —— 每一条热区上报都被拒，热区永远是 null，展台不再鼠标穿透；
//   · embedding:embed 要求 apiKey，而渲染层**永远**没有 apiKey（密钥只在主进程），
//     于是远端嵌入永远走不到（这个是 createEmbedder 里的判断，见
//     embeddings-host.test.mjs）。
// 所以这里按「真实调用点」逐条钉住，字段名改了就会红。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CHANNELS } = require('../../shared/ipc-schemas.cjs');

/** 按主进程那侧真正的调用方式校验一遍（parse 收的是参数数组） */
function accepts(channel, payload) {
  const rule = CHANNELS[channel];
  expect(rule, `${channel} 没有登记规则`).toBeTruthy();
  return rule.parse(payload === undefined ? [] : [payload], channel);
}

function rejects(channel, payload) {
  const rule = CHANNELS[channel];
  expect(rule).toBeTruthy();
  expect(() => rule.parse([payload], channel)).toThrow();
}

describe('悬浮展台（src/overlay.js 的真实载荷）', () => {
  it('热区上报用 { x, y, w, h }', () => {
    // src/overlay.js: overlaySetHitArea({ x: r.left, y: r.top, w: r.width, h: r.height })
    const out = accepts('overlay:hitArea', { x: 100.5, y: 200.25, w: 383, h: 40 });
    expect(out[0]).toMatchObject({ x: 100.5, y: 200.25, w: 383, h: 40 });
  });

  it('解析结果里必须留得住 w / h（处理器读的是 rect.w / rect.h）', () => {
    const out = accepts('overlay:hitArea', { x: 100.5, y: 200.25, w: 383, h: 40 });
    expect(out[0]).toMatchObject({ x: 100.5, y: 200.25, w: 383, h: 40 });
    // 用错字段名（width/height）时拿不到热区 —— 这正是之前展台不再穿透的原因，
    // 而且它**不会**抛错，只会静默把热区变成 0，所以只能靠这条断言钉住
    const wrong = accepts('overlay:hitArea', { x: 1, y: 1, width: 383, height: 40 });
    expect(Number(wrong[0].w) > 20 && Number(wrong[0].h) > 10).toBe(false);
  });

  it('鼠标穿透开关是布尔', () => {
    expect(accepts('overlay:setIgnore', true)).toEqual([true]);
    expect(accepts('overlay:setIgnore', false)).toEqual([false]);
    rejects('overlay:setIgnore', 'yes');
  });

  it('−/＋ 缩放载荷', () => {
    expect(accepts('overlay:resize', { dw: -40, dh: -64 })).toHaveLength(1);
  });
});

describe('嵌入模型（src/lib/memory-host.js 的真实载荷）', () => {
  // 渲染层拿到的设置里 apiKey 恒为空 → 这里**不带** apiKey 也必须合格
  it('embed 不带 apiKey 也合格', () => {
    const out = accepts('embedding:embed', {
      texts: ['你好', 'hello'],
      baseUrl: 'https://api.openai.com/v1',
      model: 'text-embedding-3-small',
    });
    expect(out[0].texts).toEqual(['你好', 'hello']);
  });

  it('embed 的文本列表必须有上限（防止一次塞爆主进程）', () => {
    rejects('embedding:embed', { texts: new Array(65).fill('x') });
    rejects('embedding:embed', { texts: 'not-an-array' });
  });

  it('获取模型 / 测试连接', () => {
    accepts('embedding:listModels', { baseUrl: 'https://api.siliconflow.cn/v1', apiKey: '' });
    accepts('embedding:test', { baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: '' });
    // 地址必须是可用的 URL，空串不算
    rejects('embedding:listModels', { baseUrl: '' });
  });
});

describe('记忆 / 知识库存储桥（src/lib/memory-host.js 的真实载荷）', () => {
  it('写 / 读 / 存在 / 删', () => {
    accepts('store:fs', { op: 'writeText', root: 'memory', path: 'memory-x.json', text: '{}' });
    accepts('store:fs', { op: 'readText', root: 'memory', path: 'memory-x.json' });
    accepts('store:fs', { op: 'exists', root: 'knowledge', path: 'documents.json' });
    accepts('store:fs', { op: 'remove', root: 'memory', path: '__selftest-probe.json' });
  });

  it('根名只认 memory / knowledge', () => {
    rejects('store:fs', { op: 'readText', root: 'characters', path: 'x.json' });
  });

  it('op 只认白名单里的那几个', () => {
    rejects('store:fs', { op: 'rm -rf', root: 'memory', path: 'x' });
  });
});

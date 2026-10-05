import { describe, it, expect } from 'vitest';
import { createReplyPacer, MIN_DELAY, MAX_DELAY } from '../../src/lib/reply-pacer.js';

function harness() {
  const texts = [];
  const stages = [];
  const breaks = [];
  const waits = [];
  const announced = [];
  const pacer = createReplyPacer({
    onText: (s) => texts.push(s),
    onStage: (m) => stages.push(m.kind + ':' + m.value),
    onBreak: () => breaks.push(true),
    onDelay: (sec) => announced.push(sec),
    sleep: async (ms) => { waits.push(ms); }, // 不真的等
  });
  return { pacer, texts, stages, breaks, waits, announced };
}

describe('reply-pacer', () => {
  it('没有 delay 时就是一段普通文本', async () => {
    const h = harness();
    h.pacer.push('你好');
    h.pacer.push('呀');
    await h.pacer.finish();
    expect(h.texts.join('')).toBe('你好呀');
    expect(h.breaks).toEqual([]);
  });

  it('delay 触发一次分段，并且真的等了对应的秒数', async () => {
    const h = harness();
    h.pacer.push("先这样<{'|'}delay:2{'|'}>再补一句");
    await h.pacer.finish();
    expect(h.texts.join('')).toBe('先这样再补一句');
    expect(h.breaks).toHaveLength(1);
    expect(h.waits).toEqual([2000]);
    expect(h.announced).toEqual([2]);
  });

  it('多次 delay = 多段（快回一句、停一下、再补一句）', async () => {
    const h = harness();
    h.pacer.push("在<{'|'}delay:0.5{'|'}>嗯…<{'|'}delay:3{'|'}>算了没事");
    await h.pacer.finish();
    expect(h.texts.join('')).toBe('在嗯…算了没事');
    expect(h.breaks).toHaveLength(2);
    expect(h.waits).toEqual([500, 3000]);
  });

  it('delay 被切在 chunk 中间也能识别', async () => {
    const h = harness();
    h.pacer.push("嗯<{'|'}del");
    h.pacer.push("ay:1{'|'}>好吧");
    await h.pacer.finish();
    expect(h.texts.join('')).toBe('嗯好吧');
    expect(h.waits).toEqual([1000]);
  });

  it('delay 不该被当成动作/表情标记', async () => {
    const h = harness();
    h.pacer.push("a<{'|'}delay:1{'|'}>b<{'|'}motion:Tap{'|'}>c");
    await h.pacer.finish();
    expect(h.stages).toEqual(['motion:Tap']);
  });

  it('秒数被夹在合理区间，模型写离谱值也不会把应用卡住', async () => {
    const h = harness();
    h.pacer.push("x<{'|'}delay:999{'|'}>y<{'|'}delay:0{'|'}>z");
    await h.pacer.finish();
    expect(h.waits[0]).toBe(MAX_DELAY * 1000);
    expect(h.waits[1]).toBe(MIN_DELAY * 1000);
  });

  it('delay 写成非法值时不炸，退回 1 秒', async () => {
    const h = harness();
    h.pacer.push("x<{'|'}delay:abc{'|'}>y");
    await h.pacer.finish();
    expect(h.waits).toEqual([1000]);
  });

  it('finish 之后不会有内容漏出来', async () => {
    const h = harness();
    h.pacer.push('尾巴<|delay');   // 故意不闭合
    await h.pacer.finish();
    expect(h.texts.join('')).toBe('尾巴<|delay');
    expect(h.waits).toEqual([]);
  });
});

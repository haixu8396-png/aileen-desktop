import { describe, it, expect } from 'vitest';
import { sha256Hex } from '../../src/lib/hash.js';
import { summaryKey } from '../../src/lib/history.js';

const msg = (role, content) => ({ role, content });

describe('sha256Hex', () => {
  it('标准测试向量对得上', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('跨过 55/56/64 字节这几个分块边界也对（补位最容易写错的地方）', () => {
    expect(sha256Hex('a'.repeat(55))).toBe('9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318');
    expect(sha256Hex('a'.repeat(56))).toBe('b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a');
    expect(sha256Hex('a'.repeat(64))).toBe('ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb');
  });

  it('中文（多字节）稳定且不等于同长度 ASCII', () => {
    expect(sha256Hex('你好')).toBe(sha256Hex('你好'));
    expect(sha256Hex('你好')).not.toBe(sha256Hex('ab'));
    expect(sha256Hex('你好')).toHaveLength(64);
  });
});

describe('summaryKey · 上下文指纹', () => {
  it('内容变了 key 就变；内容一样 key 稳定', () => {
    const a = summaryKey([msg('user', 'a')]);
    expect(a).not.toBe(summaryKey([msg('user', 'ab')]));
    expect(summaryKey([msg('user', 'a')])).toBe(a);
  });

  it('长度完全相同但内容不同 → key 必须不同（旧实现会撞车）', () => {
    const a = summaryKey([msg('user', '我喜欢猫'), msg('assistant', '我也喜欢')]);
    const b = summaryKey([msg('user', '我讨厌狗'), msg('assistant', '我也不喜欢')]);
    expect(a).not.toBe(b);
  });

  it('角色 / persona / system / 语言 / 轮数 任一不同 → key 不同', () => {
    const base = summaryKey([msg('user', 'hi')], { character: 'a.json', lang: 'zh', keepTurns: 8 });
    expect(summaryKey([msg('user', 'hi')], { character: 'b.json', lang: 'zh', keepTurns: 8 })).not.toBe(base);
    expect(summaryKey([msg('user', 'hi')], { character: 'a.json', lang: 'ja', keepTurns: 8 })).not.toBe(base);
    expect(summaryKey([msg('user', 'hi')], { character: 'a.json', lang: 'zh', keepTurns: 4 })).not.toBe(base);
    expect(summaryKey([msg('user', 'hi')], { character: 'a.json', lang: 'zh', keepTurns: 8, persona: '傲娇' })).not.toBe(base);
    expect(summaryKey([msg('user', 'hi')], { character: 'a.json', lang: 'zh', keepTurns: 8, system: 'SYS' })).not.toBe(base);
  });

  it('role 也不同（同样的字，一个 user 一个 assistant）', () => {
    expect(summaryKey([msg('user', 'x')])).not.toBe(summaryKey([msg('assistant', 'x')]));
  });

  it('空/异常输入不炸', () => {
    expect(summaryKey([])).toHaveLength(64);
    expect(summaryKey(null)).toHaveLength(64);
    expect(summaryKey(undefined, null)).toHaveLength(64);
  });
});

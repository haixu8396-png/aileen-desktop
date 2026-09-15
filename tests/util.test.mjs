import { describe, it, expect } from 'vitest';
import util from '../shared/util.cjs';

const { deepMerge, sanitizeFileName, normalizeSettings, isInsidePath } = util;

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

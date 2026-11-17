// ============================================================
// 纯 JS 路径工具单测
//
// 背景：渲染层的 executor 曾经 `import nodePath from 'node:path'`，
// 浏览器 bundle 里拿到的是 stub，调用时抛 `nodePath.resolve is not a function`
// —— 真机上「写文件 / 打补丁 / 列目录 / 读文件」全部同一个内部错误。
// 这个文件把替代实现（shared/path-util.cjs）的行为钉住。
// ============================================================
import { describe, it, expect } from 'vitest';
import pathUtil from '../../shared/path-util.cjs';

const { isAbsolute, normalize, join, resolve, relative, dirname, basename, isInside } = pathUtil;

describe('isAbsolute', () => {
  it('认 Windows 盘符与 posix 根', () => {
    expect(isAbsolute('C:/a')).toBe(true);
    expect(isAbsolute('d:\\a')).toBe(true);
    expect(isAbsolute('/a')).toBe(true);
    expect(isAbsolute('a/b')).toBe(false);
    expect(isAbsolute('./a')).toBe(false);
    expect(isAbsolute('')).toBe(false);
  });
});

describe('normalize / join', () => {
  it('统一分隔符并折叠 . 与重复分隔符（盘符路径用 \\）', () => {
    expect(normalize('C:\\A\\B')).toBe('C:\\A\\B');
    expect(normalize('C:/A/B')).toBe('C:\\A\\B');
    expect(normalize('a//b/./c')).toBe('a/b/c');
    expect(normalize('./a')).toBe('a');
  });

  it('折叠 ..（根之下的 .. 不越过根）', () => {
    expect(normalize('a/b/../c')).toBe('a/c');
    expect(normalize('/a/../..')).toBe('/');
    expect(normalize('C:/a/../../b')).toBe('C:\\b');
    expect(normalize('../a')).toBe('../a');
  });

  it('join 多个片段', () => {
    expect(join('a', 'b', 'c')).toBe('a/b/c');
    expect(join('C:/a/', '/b/')).toBe('C:\\a\\b');
  });
});

describe('resolve', () => {
  it('相对目标拼在 base 上', () => {
    expect(resolve('C:/work', 'a.txt')).toBe('C:\\work\\a.txt');
    expect(resolve('C:/work', './src/a.js')).toBe('C:\\work\\src\\a.js');
    expect(resolve('C:/work', '')).toBe('C:\\work');
  });

  it('绝对目标原样（归一化后）使用', () => {
    expect(resolve('C:/work', 'D:/other/x.txt')).toBe('D:\\other\\x.txt');
    expect(resolve('C:/work', 'C:\\other\\x.txt')).toBe('C:\\other\\x.txt');
  });

  it('.. 不能逃出根', () => {
    expect(resolve('C:/work', '../evil.txt')).toBe('C:\\evil.txt');
    expect(resolve('/work', '../evil.txt')).toBe('/evil.txt');
  });
});

describe('relative / dirname / basename', () => {
  it('relative 给出 root 之下的相对路径', () => {
    expect(relative('C:/work', 'C:/work/src/a.js')).toBe('src/a.js');
    expect(relative('C:/work', 'C:/work')).toBe('');
    expect(relative('C:/work', 'D:/other/a.js')).toBe('D:/other/a.js');
  });

  it('dirname / basename', () => {
    expect(dirname('C:/work/src/a.js')).toBe('C:\\work\\src');
    expect(dirname('C:/a.js')).toBe('C:\\');
    expect(basename('C:/work/src/a.js')).toBe('a.js');
    expect(basename('C:/work')).toBe('work');
  });
});

describe('isInside', () => {
  it('子路径算在内（Windows 大小写不敏感）', () => {
    expect(isInside('C:/Work/a.txt', 'C:/work')).toBe(true);
    expect(isInside('C:/work', 'C:/work')).toBe(true);
  });

  it('同名前缀不算在内', () => {
    expect(isInside('C:/work2/a.txt', 'C:/work')).toBe(false);
    expect(isInside('C:/work/../evil.txt', 'C:/work')).toBe(false);
  });

  it('坏输入直接 false', () => {
    expect(isInside('', 'C:/work')).toBe(false);
    expect(isInside('C:/work/a', '')).toBe(false);
    expect(isInside('C:/work/\0a', 'C:/work')).toBe(false);
  });
});

// ============================================================
// shared/fs-paths.cjs 单测：Windows 路径解析 + 范围 + 敏感 + 移动/复制校验
//
// 这一层是渲染层与主进程**共用**的规则，所以它错一次，两边一起错。
// ============================================================
import { describe, it, expect } from 'vitest';
import fsPaths from '../../shared/fs-paths.cjs';

const WS = 'C:\\Users\\me\\AileenData\\data';
const HOME = 'C:\\Users\\me';
const opts = { workspace: WS, home: HOME };
const CODE = fsPaths.CODE;

describe('resolveAgentPath：Windows 路径', () => {
  it('反斜杠绝对路径原样解析，统一成绝对形式', () => {
    const r = fsPaths.resolveAgentPath('C:\\Users\\me\\Desktop\\a.txt', opts);
    expect(r.ok).toBe(true);
    expect(r.abs).toBe('C:\\Users\\me\\Desktop\\a.txt');
  });

  it('正斜杠也能用，大小写盘符保持可用', () => {
    const r = fsPaths.resolveAgentPath('c:/users/me/Desktop/a.txt', opts);
    expect(r.ok).toBe(true);
    expect(r.abs.toLowerCase()).toBe('c:\\users\\me\\desktop\\a.txt');
  });

  it('相对路径按工作区解析', () => {
    expect(fsPaths.resolveAgentPath('a.txt', opts).abs).toBe('C:\\Users\\me\\AileenData\\data\\a.txt');
    expect(fsPaths.resolveAgentPath('sub/../a.txt', opts).abs).toBe('C:\\Users\\me\\AileenData\\data\\a.txt');
    expect(fsPaths.resolveAgentPath('.', opts).abs).toBe('C:\\Users\\me\\AileenData\\data');
  });

  it('~ 展开成主目录；没有主目录时明确报错（不静默当相对路径）', () => {
    expect(fsPaths.resolveAgentPath('~/Desktop/a.txt', opts).abs).toBe('C:\\Users\\me\\Desktop\\a.txt');
    const bad = fsPaths.resolveAgentPath('~/Desktop/a.txt', { workspace: WS });
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe(CODE.HOME_UNKNOWN);
  });

  it('盘符相对路径（C:foo）直接拒绝：含义不明确', () => {
    const r = fsPaths.resolveAgentPath('C:foo', opts);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe(CODE.INVALID_PATH);
    expect(r.error.message).toContain('盘符相对');
  });

  it('设备命名空间与 NTFS 数据流都拒绝', () => {
    for (const p of ['\\\\?\\C:\\x', '\\\\.\\PhysicalDrive0', 'C:\\x\\a.txt:hidden']) {
      const r = fsPaths.resolveAgentPath(p, opts);
      expect(r.ok, p).toBe(false);
      expect(r.error.code).toBe(CODE.INVALID_PATH);
    }
  });

  it('NUL 与非法字符拒绝', () => {
    expect(fsPaths.resolveAgentPath('a\0b', opts).error.code).toBe(CODE.INVALID_PATH);
    expect(fsPaths.resolveAgentPath('C:\\x\\a|b.txt', opts).error.code).toBe(CODE.INVALID_PATH);
  });
});

describe('范围判定', () => {
  it('工作区内/外的 scope 正确', () => {
    expect(fsPaths.scopeOf('C:\\Users\\me\\AileenData\\data\\a.txt', WS)).toBe('workspace');
    expect(fsPaths.scopeOf('C:\\Users\\me\\Desktop\\a.txt', WS)).toBe('external');
    // 大小写不敏感
    expect(fsPaths.scopeOf('c:\\users\\me\\aileendata\\DATA\\a.txt', WS)).toBe('workspace');
  });

  it('外部路径未授权 → EXTERNAL_ACCESS_REQUIRED（不是「非法路径」）', () => {
    const r = fsPaths.validateAgentPath({ target: 'C:\\Users\\me\\Desktop\\a.txt', ...opts });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe(CODE.EXTERNAL_ACCESS_REQUIRED);
    expect(r.error.message).toContain('外部文件访问');
  });

  it('授权之后外部路径通过，并标明 scope=external', () => {
    const r = fsPaths.validateAgentPath({ target: 'C:\\Users\\me\\Desktop\\a.txt', ...opts, allowExternal: true });
    expect(r.ok).toBe(true);
    expect(r.scope).toBe('external');
  });

  it('.. 逃出工作区按外部处理（不是「路径非法」）', () => {
    const r = fsPaths.validateAgentPath({ target: '../../../Windows/win.ini', ...opts });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe(CODE.EXTERNAL_ACCESS_REQUIRED);
  });
});

describe('敏感路径', () => {
  it('凭据与密钥类一律敏感', () => {
    for (const p of [
      'C:\\Users\\me\\.ssh\\id_rsa',
      'C:\\Users\\me\\.aws\\credentials',
      'C:\\Users\\me\\.git-credentials',
      'C:\\Users\\me\\proj\\.npmrc',
      'C:\\Users\\me\\proj\\settings.json',
      'C:\\Windows\\System32\\drivers\\etc\\hosts',
    ]) {
      expect(fsPaths.isSensitivePath(p), p).toBe(true);
    }
  });

  it('普通源码/文档不敏感', () => {
    expect(fsPaths.isSensitivePath('C:\\Users\\me\\Desktop\\report.docx')).toBe(false);
    expect(fsPaths.isSensitivePath('C:\\Users\\me\\proj\\src\\main.js')).toBe(false);
  });

  it('protectedRoots（AILEEN 自己的数据目录）整棵敏感', () => {
    const roots = ['C:\\Users\\me\\AileenData'];
    expect(fsPaths.isSensitivePath('C:\\Users\\me\\AileenData\\anything.txt', { protectedRoots: roots })).toBe(true);
    expect(fsPaths.isSensitivePath('C:\\Users\\me\\Desktop\\x.txt', { protectedRoots: roots })).toBe(false);
  });

  it('validateAgentPath 会把敏感路径挡在工作区内外都没用', () => {
    const r = fsPaths.validateAgentPath({ target: 'C:\\Users\\me\\.ssh\\id_rsa', ...opts, allowExternal: true });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe(CODE.SENSITIVE_PATH);
  });
});

describe('移动 / 复制校验', () => {
  it('同一个路径（含大小写差异）拒绝', () => {
    const r = fsPaths.validateMoveOperation({
      from: 'C:\\Users\\me\\Desktop\\a.txt',
      to: 'c:\\users\\me\\desktop\\A.TXT',
      ...opts,
      allowExternal: true,
    });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe(CODE.SAME_PATH);
  });

  it('目标在源目录内部拒绝（否则会无限嵌套）', () => {
    for (const fn of [fsPaths.validateMoveOperation, fsPaths.validateCopyOperation]) {
      const r = fn({ from: 'C:\\Users\\me\\Desktop\\dir', to: 'C:\\Users\\me\\Desktop\\dir\\sub', ...opts, allowExternal: true });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe(CODE.TARGET_INSIDE_SOURCE);
    }
  });

  it('不允许把工作区根目录本身搬走', () => {
    const r = fsPaths.validateMoveOperation({ from: WS, to: 'C:\\Users\\me\\Desktop\\data', ...opts, allowExternal: true });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe(CODE.INVALID_PATH);
  });

  it('跨范围移动被标记（工作区 → 桌面）', () => {
    const r = fsPaths.validateMoveOperation({
      from: 'C:\\Users\\me\\AileenData\\data\\a.txt',
      to: 'C:\\Users\\me\\Desktop\\a.txt',
      ...opts,
      allowExternal: true,
    });
    expect(r.ok).toBe(true);
    expect(r.scope).toBe('external');
    expect(r.crossScope).toBe(true);
  });

  it('复制到源内部同样拒绝；源与目标都在外部时也放行', () => {
    const bad = fsPaths.validateCopyOperation({
      from: 'C:\\Users\\me\\Desktop\\dir',
      to: 'C:\\Users\\me\\Desktop\\dir\\copy',
      ...opts,
      allowExternal: true,
    });
    expect(bad.ok).toBe(false);
    const ok = fsPaths.validateCopyOperation({
      from: 'C:\\Users\\me\\Desktop\\a.txt',
      to: 'C:\\Users\\me\\Documents\\a.txt',
      ...opts,
      allowExternal: true,
    });
    expect(ok.ok).toBe(true);
    expect(ok.scope).toBe('external');
  });
});

describe('给授权层用的辅助', () => {
  it('externalTargets 挑出参数里的外部路径', () => {
    const list = fsPaths.externalTargets(
      { path: 'a.txt', to: 'C:\\Users\\me\\Desktop\\a.txt', unrelated: 'x' },
      opts,
    );
    expect(list).toHaveLength(2);
    expect(list.find((x) => x.key === 'path').scope).toBe('workspace');
    expect(list.find((x) => x.key === 'to').scope).toBe('external');
  });

  it('describePath 输出好读的短形式', () => {
    expect(fsPaths.describePath('C:\\Users\\me\\AileenData\\data\\sub\\a.txt', opts)).toBe('工作区/sub/a.txt');
    expect(fsPaths.describePath('C:\\Users\\me\\Desktop\\a.txt', opts)).toBe('~/Desktop/a.txt');
  });
});

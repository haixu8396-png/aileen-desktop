// ============================================================
// 命令策略（shared/command-policy.cjs）单测
//
// 这个文件现在是**主进程出口处**用的那一份，所以它的漏判等于任意命令执行。
// 重点：白名单、脚本文件、危险参数、shell 元字符、git push。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkCommand, COMMAND_WHITELIST, baseName } = require('../../shared/command-policy.cjs');

describe('baseName', () => {
  it('去掉目录与扩展名，转小写', () => {
    expect(baseName('C:\\Program Files\\nodejs\\node.exe')).toBe('node');
    expect(baseName('/usr/bin/git')).toBe('git');
    expect(baseName('PowerShell.EXE')).toBe('powershell');
    expect(baseName('')).toBe('');
  });
});

describe('白名单', () => {
  it('常用开发命令放行', () => {
    for (const cmd of ['node', 'npm', 'git', 'python', 'rg']) {
      expect(checkCommand(cmd, [])).toMatchObject({ ok: true });
      expect(COMMAND_WHITELIST).toContain(cmd);
    }
  });

  it('白名单之外的程序拒绝', () => {
    for (const cmd of ['powershell', 'cmd', 'wscript', 'curl', 'certutil']) {
      expect(checkCommand(cmd, []).ok).toBe(false);
      expect(checkCommand(cmd, []).code).toBe('NOT_WHITELISTED');
    }
  });

  it('脚本文件不能直接跑', () => {
    expect(checkCommand('evil.bat', []).code).toBe('SCRIPT_FILE');
    expect(checkCommand('run.ps1', []).code).toBe('SCRIPT_FILE');
    expect(checkCommand('x.vbs', []).code).toBe('SCRIPT_FILE');
  });

  it('空命令拒绝', () => {
    expect(checkCommand('', []).code).toBe('NO_COMMAND');
    expect(checkCommand('   ', []).code).toBe('NO_COMMAND');
  });
});

describe('危险参数', () => {
  it('-e / --eval / --exec 一律拒绝（把代码当参数）', () => {
    for (const arg of ['-e', '--eval', '--exec', '-e=1', '--exec:1']) {
      const r = checkCommand('node', [arg, 'console.log(1)']);
      expect(r.ok).toBe(false);
      expect(r.code).toBe('DANGEROUS_ARG');
    }
  });

  it('-c 不拦（pip -c / gradle -c 是正常用法）', () => {
    expect(checkCommand('pip', ['-c', 'constraints.txt']).ok).toBe(true);
  });

  it('--prefix / --global / --force 拒绝', () => {
    expect(checkCommand('npm', ['--prefix', '/tmp']).code).toBe('DANGEROUS_ARG');
    expect(checkCommand('npm', ['--global', 'install']).code).toBe('DANGEROUS_ARG');
  });

  it('shell 元字符拒绝', () => {
    for (const arg of ['a;b', 'a&&b', 'a|b', 'a>b', 'a`b', 'a$b', 'a\nb']) {
      expect(checkCommand('git', ['log', arg]).ok).toBe(false);
    }
  });
});

describe('git 特殊规则', () => {
  it('push 走单独的高风险工具，这里拒绝', () => {
    expect(checkCommand('git', ['push']).code).toBe('GIT_PUSH');
    expect(checkCommand('git', ['push', 'origin', 'main']).code).toBe('GIT_PUSH');
  });

  it('status / diff / commit 放行', () => {
    expect(checkCommand('git', ['status', '--short']).ok).toBe(true);
    expect(checkCommand('git', ['commit', '-m', 'msg']).ok).toBe(true);
  });
});

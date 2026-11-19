'use strict';
// ============================================================
// 命令策略（唯一来源）
//
// 这个文件存在的理由：白名单以前只写在渲染层的 executor 里。
// 渲染层一旦被注入（或有人在 devtools 里直接调 window.api.agentExec），
// 主进程照单全收 —— 「渲染层被控 = 任意命令执行」。
//
// 现在策略只有这一份，两边都调它：
//   · src/agent/executor.js   （渲染层，执行前先问一遍，给出人话错误）
//   · shared/agent-ipc.cjs    （主进程，出口处再问一遍 —— 这一道绕不过去）
//
// 纯 JS、不 import 任何 node: 内置模块：渲染层要能直接 import。
// ============================================================

/** 允许执行的程序（白名单）。不在表里的一律拒绝。 */
const COMMAND_WHITELIST = [
  'node', 'npm', 'npx', 'git', 'pnpm', 'yarn',
  'python', 'python3', 'py', 'pip', 'uv',
  'cargo', 'go', 'dotnet', 'java', 'mvn', 'gradle',
  'rg', 'ls', 'dir', 'cat', 'type', 'echo', 'where', 'which',
];

/** 参数模式黑名单：命中就拒（这些参数能反过来执行任意命令/删盘） */
const ARG_PATTERNS = [
  // -e / --exec / --eval 这类参数等于「把代码当参数传进去执行」，绕开一切白名单。
  // 注意不要加 -c：pip -c / gradle -c 是正常用法，把它拦掉会误伤正经命令。
  { re: /^-{1,2}(e|exec|eval)([=:].*)?$/i, why: '参数可以执行任意代码' },
  { re: /^-{1,2}(command|prefix)$/i, why: '参数可以改写要执行的程序' },
  { re: /^-{1,2}(global|g)$/i, why: '会改动全局环境' },
  { re: /^-{1,2}(force|f)$/i, why: '强制模式风险过高' },
  { re: /\bnpm\s+(i|install|add)\b/i, why: '安装依赖会执行 postinstall 脚本' },
];

function baseName(cmd) {
  const s = String(cmd || '').trim();
  const parts = s.split(/[\\/]/);
  return (parts[parts.length - 1] || '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/**
 * 命令策略校验。
 * @returns {{ok:boolean, why?:string, code?:string}}
 */
function checkCommand(command, args) {
  const raw = String(command || '').trim();
  const base = baseName(command);
  if (!base) return { ok: false, code: 'NO_COMMAND', why: '没有指定要执行什么命令' };
  // 判的是**原始命令串的扩展名**（baseName 已经把 .bat/.ps1 去掉，
  // 拿 base 判这条永远不成立 —— 以前那份就是这么写的，等于没判）
  if (/\.(bat|cmd|ps1|vbs|js)$/i.test(raw)) {
    return { ok: false, code: 'SCRIPT_FILE', why: '不允许直接执行脚本文件（请用 node/npm 等解释器）' };
  }
  if (!COMMAND_WHITELIST.includes(base)) {
    return { ok: false, code: 'NOT_WHITELISTED', why: '程序 "' + base + '" 不在白名单里' };
  }
  const list = Array.isArray(args) ? args.map((a) => String(a)) : [];
  for (const arg of list) {
    if (/[\r\n\0]/.test(arg)) return { ok: false, code: 'BAD_ARG', why: '参数里含有换行或空字符' };
    if (/[;&|`$><]/.test(arg)) {
      return { ok: false, code: 'SHELL_META', why: '参数里含有 shell 元字符：' + arg.slice(0, 40) };
    }
    for (const p of ARG_PATTERNS) {
      if (p.re.test(arg)) return { ok: false, code: 'DANGEROUS_ARG', why: p.why + '（' + arg + '）' };
    }
  }
  if (base === 'git' && list[0] === 'push') {
    return { ok: false, code: 'GIT_PUSH', why: 'git push 由单独的高风险工具负责，这里不允许' };
  }
  return { ok: true };
}

module.exports = { COMMAND_WHITELIST, ARG_PATTERNS, baseName, checkCommand };

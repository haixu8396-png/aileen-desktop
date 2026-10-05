'use strict';
// ============================================================
// 电脑控制的输入注入（鼠标 / 键盘）—— Windows 平台
//
// 为什么走 PowerShell 而不是装 robotjs / nut.js：
//   · 那两个包都有原生模块，要 node-gyp 编译，会把打包和 CI 拖垮；
//   · 这个项目已经处处依赖 PowerShell（MC / 自检 / 构建），加一段 P/Invoke
//     是**零新依赖**的解法；
//   · 脚本是**参数化生成**的（坐标/按键都过严格校验），不是拼接用户输入。
//
// 安全：所有数值都收敛到合法范围，文本走 base64 传参（避免引号/中文注入），
//       按键只在白名单里。这一层不负责「要不要问用户」——那是权限层的事。
// ============================================================

const { spawn } = require('child_process');

/** 允许按下的键（白名单）：常用功能键 + 字母数字 + 少量符号 */
const KEY_WHITELIST = [
  'enter', 'tab', 'esc', 'escape', 'space', 'backspace', 'delete', 'insert',
  'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right',
  'ctrl', 'control', 'alt', 'shift', 'win', 'meta',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  '-', '=', ',', '.', '/',
  // 注意：**不要**把 ; & | > < $ ( ) [ ] { } ` \ 加进来 ——
  // 这些是 shell 元字符，任何要拼进命令行的东西都不该接受它们。
];

function isWindows() {
  return process.platform === 'win32';
}

/** 坐标收敛：防止把鼠标移到多屏之外或塞进奇怪的值 */
function clampCoord(v, max = 20000) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) throw new Error('坐标必须是数字');
  return Math.max(-max, Math.min(max, n));
}

/** 按键规范化 + 白名单校验 */
function normalizeKey(k) {
  const s = String(k || '').trim().toLowerCase();
  if (!s) throw new Error('按键不能为空');
  if (!KEY_WHITELIST.includes(s)) throw new Error('不支持的按键：' + s);
  return s;
}

/** 把白名单按键翻成 SendKeys 能认的写法 */
function toSendKeys(key) {
  const map = {
    enter: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}', space: ' ',
    backspace: '{BACKSPACE}', delete: '{DELETE}', insert: '{INSERT}',
    home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
    up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
    ctrl: '^', control: '^', alt: '%', shift: '+',
  };
  if (map[key]) return map[key];
  if (/^f\d{1,2}$/.test(key)) return '{' + key.toUpperCase() + '}';
  // 单字符直接用（SendKeys 对 + ^ % ~ ( ) { } [ ] 有特殊含义，做转义）
  if (key.length === 1) return /[+^%~(){}[\]]/.test(key) ? '{' + key + '}' : key;
  return '';
}

/** 跑一段 PowerShell 脚本，返回 { ok, out, err } */
function runPwsh(script, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, err: String((err && err.message) || err) });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, timeoutMs);
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { err += c.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, err: String(e && e.message || e) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out: out.trim(), err: err.trim() });
    });
  });
}

/** 鼠标动作的 P/Invoke 脚本（坐标与动作都是校验过的数值） */
function mouseScript(action, x, y) {
  const header = [
    'Add-Type -Namespace A -Name N -MemberDefinition @\'',
    '[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
    '[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, int e);',
    '\'@',
  ].join('\n');
  if (action === 'move') {
    return header + '\n[A.N]::SetCursorPos(' + x + ', ' + y + ')';
  }
  const flags = {
    left: { down: '0x0002', up: '0x0004' },
    right: { down: '0x0008', up: '0x0010' },
    middle: { down: '0x0020', up: '0x0040' },
  }[action];
  if (!flags) throw new Error('未知的鼠标动作：' + action);
  return header + '\n[A.N]::mouse_event(' + flags.down + ',0,0,0,0)\n[A.N]::mouse_event(' + flags.up + ',0,0,0,0)';
}

/** 键盘输入的脚本：文字走 base64，避免引号与中文被 PowerShell 吃掉 */
function typeScript(text) {
  const b64 = Buffer.from(String(text), 'utf8').toString('base64');
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    "$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "'))",
    '[System.Windows.Forms.SendKeys]::SendWait($t)',
  ].join('\n');
}

/** 快捷键脚本：**先逐个过白名单**，再译成 SendKeys 写法（不在白名单就抛错） */
function pressScript(keys) {
  const seq = (Array.isArray(keys) ? keys : []).map((k) => {
    const norm = normalizeKey(k);
    const mapped = toSendKeys(norm);
    if (!mapped) throw new Error('按键无法翻译成 SendKeys：' + norm);
    return mapped;
  }).join('');
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    "[System.Windows.Forms.SendKeys]::SendWait('" + seq.replace(/'/g, "''") + "')",
  ].join('\n');
}

/** 列窗口标题（用主窗口标题，零依赖） */
function listWindowsScript() {
  return [
    'Get-Process | Where-Object { $_.MainWindowTitle -ne "" } |',
    '  Select-Object -First 40 -ExpandProperty MainWindowTitle',
  ].join('\n');
}

/** 把匹配标题的窗口切到前台 */
function focusWindowScript(title) {
  const b64 = Buffer.from(String(title), 'utf8').toString('base64');
  return [
    'Add-Type -Namespace A -Name W -MemberDefinition @\'',
    '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
    '\'@',
    "$k = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "'))",
    '$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*$k*" } | Select-Object -First 1',
    'if (-not $p) { Write-Output "NOT_FOUND"; exit 3 }',
    '[A.W]::ShowWindow($p.MainWindowHandle, 9) | Out-Null',
    '[A.W]::SetForegroundWindow($p.MainWindowHandle) | Out-Null',
    'Write-Output $p.MainWindowTitle',
  ].join('\n');
}

module.exports = {
  isWindows,
  clampCoord,
  normalizeKey,
  toSendKeys,
  runPwsh,
  mouseScript,
  typeScript,
  pressScript,
  listWindowsScript,
  focusWindowScript,
  KEY_WHITELIST,
};

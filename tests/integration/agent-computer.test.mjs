import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import agentIpc from '../../shared/agent-ipc.cjs';
import desktopRoutes from '../../shared/desktop-input.cjs';

const require = createRequire(import.meta.url);
const { registerAgentIpc } = agentIpc;
const {
  isWindows, clampCoord, normalizeKey, toSendKeys,
  mouseScript, typeScript, pressScript, listWindowsScript, focusWindowScript,
  runPwsh, KEY_WHITELIST,
} = desktopRoutes;

const win = isWindows();

// ---------------------------------------------------------------------------
// 电脑控制：脚本生成（平台无关，一定跑）+ 真机执行（只在 Windows 上跑）
// ---------------------------------------------------------------------------

describe('坐标与按键的校验（防注入的第一道）', () => {
  it('坐标收敛到合法范围', () => {
    expect(clampCoord(100)).toBe(100);
    expect(clampCoord('250')).toBe(250);
    expect(clampCoord(999999)).toBe(20000);
    expect(clampCoord(-999999)).toBe(-20000);
  });
  it('非数字坐标直接拒绝', () => {
    expect(() => clampCoord('abc')).toThrow(/必须是数字/);
    expect(() => clampCoord(NaN)).toThrow(/必须是数字/);
  });
  it('按键白名单：常用键放行，危险/未知键拒绝', () => {
    expect(normalizeKey('ENTER')).toBe('enter');
    expect(normalizeKey('Ctrl')).toBe('ctrl');
    expect(normalizeKey('a')).toBe('a');
    expect(() => normalizeKey('rm')).toThrow(); // 'rm' 不是键名
    expect(() => normalizeKey('')).toThrow(/不能为空/);
    expect(() => normalizeKey('}; rm -rf /')).toThrow(/不支持的按键/);
  });
  it('白名单里没有 shell 能利用的东西', () => {
    for (const bad of [';', '&', '|', '>', '$', '(', ')']) {
      expect(KEY_WHITELIST).not.toContain(bad);
    }
  });
});

describe('脚本生成', () => {
  it('鼠标移动脚本带 P/Invoke 与数值坐标', () => {
    const s = mouseScript('move', 640, 360);
    expect(s).toContain('SetCursorPos(640, 360)');
    expect(s).toContain('user32.dll');
  });
  it('点击脚本用 mouse_event 的按下+抬起', () => {
    const left = mouseScript('left', 0, 0);
    expect(left).toContain('0x0002');
    expect(left).toContain('0x0004');
    expect(mouseScript('right', 0, 0)).toContain('0x0008');
    expect(() => mouseScript('bogus', 0, 0)).toThrow(/未知的鼠标动作/);
  });
  it('文字输入走 base64，避免引号与中文被 PowerShell 吃掉', () => {
    const text = '他说："你好" & 再见';
    const s = typeScript(text);
    expect(s).not.toContain(text);                       // 原文不出现在脚本里
    expect(s).toContain(Buffer.from(text, 'utf8').toString('base64'));
    expect(s).toContain('SendKeys');
  });
  it('快捷键脚本：组合键译成 SendKeys 写法', () => {
    const s = pressScript(['ctrl', 'c']);
    expect(s).toContain("'^c'");
    expect(pressScript(['enter'])).toContain('{ENTER}');
    expect(pressScript(['alt', 'f4'])).toContain('%{F4}');
  });
  it('窗口脚本：标题走 base64，并且有找不到时的出口', () => {
    const s = focusWindowScript('记事本');
    expect(s).toContain(Buffer.from('记事本', 'utf8').toString('base64'));
    expect(s).toContain('NOT_FOUND');
    expect(listWindowsScript()).toContain('MainWindowTitle');
  });
});

describe('agent-ipc：电脑控制处理器', () => {
  let workspace;
  let handlers;
  const call = (channel, payload) => handlers.get(channel)({ sender: {} }, payload);

  function register() {
    handlers = new Map();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aileen-computer-'));
    registerAgentIpc({
      handle: (c, fn) => handlers.set(c, fn),
      getSettings: () => ({ agent: { workspace, requireMedium: true, computerUse: true } }),
      defaultWorkspace: () => workspace,
      captureScreen: async ({ withData } = {}) => ({ count: 1, width: 1920, height: 1080, dataUrl: withData ? 'data:image/png;base64,AA' : '' }),
      electron: { shell: { openExternal: async (u) => { handlers.lastExternal = u; } } },
      cursorPoint: () => ({ x: 100, y: 200, scale: 1.5, size: { width: 2880, height: 1620 } }),
      log: () => {},
    });
  }

  it('agent:cursor 回鼠标位置与缩放', async () => {
    register();
    const res = await call('agent:cursor');
    expect(res).toMatchObject({ x: 100, y: 200, scale: 1.5 });
  });

  it('agent:window 未知操作拒绝', async () => {
    register();
    await expect(call('agent:window', { op: 'kill' })).rejects.toThrow(/未知的 agent:window/);
  });

  it('agent:open 只放行 http(s) 与干净程序名（挡住塞路径/参数）', async () => {
    register();
    await expect(call('agent:open', { target: 'C:\\Windows\\System32\\cmd.exe' })).rejects.toThrow(/只允许 http/);
    await expect(call('agent:open', { target: 'notepad & rm -rf /' })).rejects.toThrow(/只允许 http/);
    await expect(call('agent:open', {})).rejects.toThrow(/缺少要打开的目标/);
  });

  it('agent:open 的网址走 shell.openExternal', async () => {
    register();
    const res = await call('agent:open', { target: 'https://example.com/a?b=1' });
    expect(handlers.lastExternal).toBe('https://example.com/a?b=1');
    expect(res.text).toContain('example.com');
  });

  it('agent:input 未知操作拒绝', async () => {
    register();
    await expect(call('agent:input', { op: 'reboot' })).rejects.toThrow(/未知的 agent:input/);
  });

  it('agent:input 的鼠标键白名单', async () => {
    register();
    if (!win) return; // 非 Windows 平台会先抛「只支持 Windows」，这里只验 Windows
    await expect(call('agent:input', { op: 'mouseClick', button: 'warp' })).rejects.toThrow(/不支持的鼠标键/);
  });

  it('agent:input 的按键先过白名单，非法键不会执行到脚本', async () => {
    register();
    await expect(call('agent:input', { op: 'keyboardPress', keys: ['ctrl', '}; rm -rf /'] })).rejects.toThrow();
  });
});

describe('真机执行（仅 Windows）', () => {
  it.runIf(win)('listWindowsScript 能列到窗口标题（至少不报错）', async () => {
    const res = await runPwsh(listWindowsScript(), 20000);
    expect(res.ok).toBe(true);
    expect(typeof res.out).toBe('string');
  }, 30000);

  it.runIf(win)('鼠标移动真的能移动（移到当前光标位置，无副作用）', async () => {
    // 把鼠标移到它现在所在的位置 —— 这是**无副作用**的真机验证：
    // 既证明 P/Invoke 链路通，又不会打扰用户正在做的事。
    const pos = await runPwsh(
      'Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; Write-Output "$($p.X),$($p.Y)"',
      15000,
    );
    expect(pos.ok).toBe(true);
    const [x, y] = pos.out.split(',').map((n) => parseInt(n, 10));
    expect(Number.isFinite(x)).toBe(true);
    const move = await runPwsh(mouseScript('move', x, y), 15000);
    expect(move.ok).toBe(true);
  }, 40000);

  it.runIf(win)('非法按键在 normalizeKey 就被拦下（不会走到 SendKeys）', () => {
    expect(() => pressScript(['rm -rf /'])).toThrow(/不支持的按键/);
  });
});

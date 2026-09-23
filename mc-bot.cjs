// ============================================================
// AILEEN — Minecraft AI 伙伴（主进程）
// 基于 MIT 许可的 mineflayer（https://github.com/PrismarineJS/mineflayer）
// 与 mineflayer-pathfinder（MIT）实现「跟着我走」。
// 只在主进程运行；渲染层通过 IPC 连接/断开/说话/查状态，并接收事件流。
// 设计原则：任何异常都不能拖垮主应用，全部 try/catch 收敛成日志。
// ============================================================

let bot = null;
let send = () => {};
let lastError = '';
let cfg = { host: '127.0.0.1', port: 25565, username: 'AILEEN', version: '', auth: 'offline' };
let following = '';
const logs = [];

function pushLog(type, text) {
  const entry = { t: Date.now(), type, text: String(text == null ? '' : text).slice(0, 400) };
  logs.push(entry);
  if (logs.length > 200) logs.shift();
  send('mc:event', { kind: 'log', entry });
  return entry;
}

function snapshot() {
  if (!bot || !bot.entity) {
    return { connected: false, connecting: false, host: cfg.host, port: cfg.port, username: cfg.username, lastError, following, players: [], log: logs.slice(-40) };
  }
  let pos = null;
  try { pos = { x: Math.round(bot.entity.position.x), y: Math.round(bot.entity.position.y), z: Math.round(bot.entity.position.z) }; } catch (e) { pos = null; }
  let players = [];
  try { players = Object.keys(bot.players || {}); } catch (e) { players = []; }
  return {
    connected: true,
    connecting: false,
    host: cfg.host,
    port: cfg.port,
    username: bot.username || cfg.username,
    health: bot.health,
    food: bot.food,
    dimension: bot.game && bot.game.dimension,
    pos,
    players,
    following,
    lastError,
    log: logs.slice(-40),
  };
}

function broadcast() {
  send('mc:event', { kind: 'state', state: snapshot() });
}

function detach() {
  if (!bot) return;
  const b = bot;
  bot = null;
  following = '';
  try { b.removeAllListeners(); } catch (e) { /* ignore */ }
  try { b.quit(); } catch (e) { /* 已经断了 */ }
}

function disconnect(reason) {
  if (!bot) return { ok: true, connected: false };
  pushLog('info', '断开连接' + (reason ? '：' + reason : ''));
  detach();
  broadcast();
  return { ok: true, connected: false };
}

function connect(opts) {
  const o = opts || {};
  cfg = {
    host: String(o.host || '127.0.0.1').trim(),
    port: Math.max(1, Math.min(65535, parseInt(o.port, 10) || 25565)),
    username: String(o.username || 'AILEEN').trim().slice(0, 16) || 'AILEEN',
    version: String(o.version || '').trim(),
    auth: o.auth === 'microsoft' ? 'microsoft' : 'offline',
  };
  if (!cfg.host) return { ok: false, error: '请填写服务器地址' };

  detach();
  lastError = '';

  let mineflayer;
  try {
    mineflayer = require('mineflayer');
  } catch (err) {
    lastError = 'mineflayer 未安装：' + String((err && err.message) || err);
    pushLog('error', lastError);
    return { ok: false, error: lastError };
  }

  let pathfinder = null;
  let goals = null;
  try {
    const pf = require('mineflayer-pathfinder');
    pathfinder = pf.pathfinder;
    goals = pf.goals;
  } catch (err) {
    pushLog('warn', '未安装 mineflayer-pathfinder，「跟着我走」将不可用');
  }

  pushLog('info', '正在连接 ' + cfg.host + ':' + cfg.port + ' …');
  try {
    bot = mineflayer.createBot({
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      auth: cfg.auth,
      version: cfg.version || false,
      checkTimeoutInterval: 60000,
    });
  } catch (err) {
    bot = null;
    lastError = String((err && err.message) || err);
    pushLog('error', '创建机器人失败：' + lastError);
    return { ok: false, error: lastError };
  }

  bot.once('spawn', () => {
    if (pathfinder) { try { bot.loadPlugin(pathfinder); } catch (e) { /* ignore */ } }
    pushLog('ok', '已进入服务器，角色名 ' + bot.username);
    broadcast();
  });

  bot.on('message', (jsonMsg, position) => {
    let text = '';
    try { text = jsonMsg.toString(); } catch (e) { text = String(jsonMsg); }
    if (!text || !text.trim()) return;
    // 只把聊天/系统消息推给渲染层，动作栏（position=2）忽略
    if (position === 2) return;
    pushLog('chat', text);
    send('mc:event', { kind: 'chat', text, username: null });
  });

  bot.on('playerJoined', (p) => { if (p && p.username) pushLog('info', p.username + ' 加入了游戏'); broadcast(); });
  bot.on('playerLeft', (p) => { if (p && p.username) pushLog('info', p.username + ' 离开了游戏'); broadcast(); });
  bot.on('health', broadcast);
  bot.on('death', () => pushLog('warn', '角色死了……正在重生'));
  bot.on('kicked', (reason) => {
    let r = reason;
    try { r = JSON.stringify(reason); } catch (e) { r = String(reason); }
    lastError = '被服务器踢出：' + r;
    pushLog('error', lastError);
    detach();
    broadcast();
  });
  bot.on('error', (err) => {
    lastError = String((err && err.message) || err);
    pushLog('error', lastError);
    send('mc:event', { kind: 'state', state: snapshot() });
  });
  bot.on('end', (reason) => {
    pushLog('info', '连接结束' + (reason ? '：' + reason : ''));
    detach();
    broadcast();
  });

  return { ok: true, connecting: true };
}

function say(text) {
  const t = String(text || '').replace(/[\r\n]+/g, ' ').slice(0, 240).trim();
  if (!t) return { ok: false, error: '内容为空' };
  if (!bot || !bot.entity) return { ok: false, error: '还没有连接服务器' };
  try {
    bot.chat(t);
    pushLog('self', t);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function follow(name) {
  if (!bot || !bot.entity) return { ok: false, error: '还没有连接服务器' };
  const target = String(name || '').trim();
  if (!target) return { ok: false, error: '请填写玩家名' };
  const p = bot.players && bot.players[target];
  if (!p || !p.entity) return { ok: false, error: '找不到玩家 ' + target + '（要先让他进服务器）' };
  try {
    const pf = require('mineflayer-pathfinder');
    const movements = new pf.Movements(bot);
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.setGoal(new pf.goals.GoalFollow(p.entity, 2), true);
    following = target;
    pushLog('info', '开始跟着 ' + target + ' 走');
    broadcast();
    return { ok: true, following: target };
  } catch (err) {
    return { ok: false, error: '跟随后台不可用：' + String((err && err.message) || err) };
  }
}

function stopFollow() {
  following = '';
  try { if (bot && bot.pathfinder) bot.pathfinder.setGoal(null); } catch (e) { /* ignore */ }
  pushLog('info', '停止跟随');
  broadcast();
  return { ok: true };
}

/** 手动让机器人朝某个方向走一步（给 UI 上的方向键用） */
function step(dir, ms) {
  if (!bot || !bot.entity) return { ok: false, error: '还没有连接服务器' };
  const map = { forward: 'forward', back: 'back', left: 'left', right: 'right' };
  const d = map[dir];
  if (!d) return { ok: false, error: '未知方向' };
  const dur = Math.max(100, Math.min(4000, parseInt(ms, 10) || 600));
  try {
    bot.setControlState(d, true);
    setTimeout(() => { try { bot.setControlState(d, false); } catch (e) { /* ignore */ } }, dur);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function jump() {
  if (!bot || !bot.entity) return { ok: false, error: '还没有连接服务器' };
  try { bot.setControlState('jump', true); setTimeout(() => { try { bot.setControlState('jump', false); } catch (e) { /* ignore */ } }, 300); return { ok: true }; }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
}

module.exports = {
  init(sendFn) { send = typeof sendFn === 'function' ? sendFn : () => {}; },
  connect,
  disconnect,
  say,
  follow,
  stopFollow,
  step,
  jump,
  status: () => snapshot(),
  logs: () => logs.slice(-200),
  isConnected: () => !!(bot && bot.entity),
};

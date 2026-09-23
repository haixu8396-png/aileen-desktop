// ============================================================
// 国际象棋控制器
// 对手是 MIT 许可的 js-chess-engine（纯 JS、零依赖、自带 AI）
// 可选：让当前角色用 LLM 对棋局点评几句
// ============================================================
import { Game } from 'js-chess-engine';
import { getSettings, saveSettings } from './settings.js';
import { state } from './state.js';
import { t } from './i18n.js';
import { $, toast } from './dom.js';
import { streamChat } from './llm.js';
import { buildSystemPrompt } from './characters.js';

const GLYPH = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙', k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const FILES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

let game = null;
let fenStack = [];
let level = 3;
let playerColor = 'white';
let banter = false;
let flipped = false;
let selected = null;
let legal = {};
let busy = false;
let finished = false;
let bound = false;
let lastMove = null;

function el(id) { return document.getElementById(id); }

function board() {
  try { return game.exportJson(); } catch (err) { return { pieces: {}, turn: 'white' }; }
}

// ---------------- 渲染 ----------------
function renderBoard() {
  const box = el('chess-board');
  if (!box) return;
  const b = board();
  const pieces = b.pieces || {};
  box.innerHTML = '';
  const ranks = flipped ? ['1','2','3','4','5','6','7','8'] : ['8','7','6','5','4','3','2','1'];
  const files = flipped ? FILES.slice().reverse() : FILES;
  const dests = (selected && legal[selected]) ? legal[selected] : [];
  for (const r of ranks) {
    for (const f of files) {
      const sq = f + r;
      const dark = (FILES.indexOf(f) + Number(r)) % 2 === 0;
      const cell = document.createElement('div');
      cell.className = 'csq ' + (dark ? 'dark' : 'light');
      cell.dataset.sq = sq;
      if (selected === sq) cell.classList.add('sel');
      if (dests.indexOf(sq) >= 0) cell.classList.add('can');
      if (lastMove && (lastMove.from === sq || lastMove.to === sq)) cell.classList.add('last');
      const sym = pieces[sq];
      if (sym) {
        const span = document.createElement('span');
        span.className = 'cpiece ' + (sym === sym.toUpperCase() ? 'w' : 'b');
        span.textContent = GLYPH[sym] || '';
        cell.appendChild(span);
      }
      cell.onclick = () => onSquare(sq);
      box.appendChild(cell);
    }
  }
}

function renderCaptured() {
  const box = el('chess-captured');
  if (!box) return;
  const b = board();
  const pieces = b.pieces || {};
  const start = { P: 8, N: 2, B: 2, R: 2, Q: 1, p: 8, n: 2, b: 2, r: 2, q: 1 };
  const now = {};
  for (const k of Object.keys(pieces)) { const s = pieces[k]; now[s] = (now[s] || 0) + 1; }
  const gone = [];
  for (const k of Object.keys(start)) {
    const n = start[k] - (now[k] || 0);
    for (let i = 0; i < n; i += 1) gone.push(GLYPH[k]);
  }
  box.textContent = gone.length ? gone.join(' ') : '';
}

function renderStatus() {
  const box = el('chess-status');
  if (!box) return;
  const b = board();
  let text = '';
  if (b.checkMate) text = b.turn === playerColor ? t('chess.checkmateAi') : t('chess.checkmateYou');
  else if (b.staleMate) text = t('chess.stalemate');
  else if (finished) text = t('chess.resigned');
  else if (busy) text = t('chess.turnAi');
  else text = b.turn === playerColor ? t('chess.turnYou') : t('chess.turnAi');
  if (b.check && !b.checkMate) text += ' · ' + t('chess.check');
  box.textContent = text;
  box.className = 'chess-status' + (b.checkMate || b.staleMate ? ' over' : '');
}

function renderMoves() {
  const box = el('chess-moves');
  if (!box) return;
  let hist = [];
  try { hist = game.getHistory() || []; } catch (err) { hist = []; }
  if (!hist.length) { box.innerHTML = '<span class="hint">' + t('chess.noMoves') + '</span>'; return; }
  const items = [];
  for (let i = 0; i < hist.length; i += 1) {
    const mv = hist[i].move || {};
    const from = Object.keys(mv)[0] || '';
    const to = mv[from] || '';
    const n = Math.floor(i / 2) + 1;
    if (i % 2 === 0) items.push('<span class="mv-no">' + n + '.</span> ' + from + '→' + to);
    else items[items.length - 1] += ' <span class="mv-b">' + from + '→' + to + '</span>';
  }
  box.innerHTML = items.map((s) => '<div class="mv-line">' + s + '</div>').join('');
  box.scrollTop = box.scrollHeight;
}

function renderAll() { renderBoard(); renderCaptured(); renderStatus(); renderMoves(); }

// ---------------- 走子 ----------------
function refreshLegal() {
  try { legal = game.moves() || {}; } catch (err) { legal = {}; }
}

function onSquare(sq) {
  if (busy || finished) return;
  const b = board();
  if (b.checkMate || b.staleMate) return;
  if (selected && legal[selected] && legal[selected].indexOf(sq) >= 0) {
    doPlayerMove(selected, sq);
    return;
  }
  const pieces = b.pieces || {};
  const sym = pieces[sq];
  if (sym && ((b.turn === 'white' && sym === sym.toUpperCase()) || (b.turn === 'black' && sym === sym.toLowerCase()))) {
    if (b.turn !== playerColor) return;
    selected = sq;
    renderBoard();
  } else {
    selected = null;
    renderBoard();
  }
}

async function doPlayerMove(from, to) {
  try { game.move(from, to); } catch (err) { toast(String((err && err.message) || err), true); return; }
  fenStack.push(game.exportFEN());
  selected = null;
  lastMove = { from, to };
  persist();
  refreshLegal();
  renderAll();
  await maybeAiMove();
}

async function maybeAiMove() {
  const b = board();
  if (b.checkMate || b.staleMate || finished) return;
  if (b.turn === playerColor) return;
  busy = true;
  renderStatus();
  await new Promise((r) => setTimeout(r, 120));
  try {
    const res = game.ai({ level, randomness: 20 });
    const mv = (res && res.move) || {};
    const from = Object.keys(mv)[0] || '';
    lastMove = { from, to: mv[from] || '' };
    fenStack.push(game.exportFEN());
    persist();
  } catch (err) {
    toast('AI: ' + String((err && err.message) || err), true);
  }
  busy = false;
  refreshLegal();
  renderAll();
  if (banter) comment();
}

// ---------------- 角色点评 ----------------
async function comment() {
  const box = el('chess-comment');
  if (!box) return;
  if (!getSettings().llm.apiKey) return;
  const card = state.current && state.current.data ? state.current.data : null;
  let fen = '';
  try { fen = game.exportFEN(); } catch (err) { fen = ''; }
  const hist = (() => { try { return game.getHistory() || []; } catch (err) { return []; } })();
  const last = hist.length ? hist[hist.length - 1].move : null;
  const lastTxt = last ? Object.keys(last)[0] + '→' + last[Object.keys(last)[0]] : '-';
  box.classList.remove('hidden');
  box.textContent = '…';
  try {
    let out = '';
    await streamChat({
      messages: [
        { role: 'system', content: buildSystemPrompt(card) + '\n\n' + t('prompt.chessRule') },
        { role: 'user', content: 'FEN: ' + fen + '\n刚走的一步: ' + lastTxt },
      ],
      settings: getSettings(),
      onDelta: (d) => { out += d; },
    });
    box.textContent = String(out).replace(/[\r\n]+/g, ' ').trim() || '…';
  } catch (err) {
    box.classList.add('hidden');
  }
}

// ---------------- 持久化 ----------------
function persist() {
  const next = Object.assign({}, getSettings());
  next.chess = { level, playerColor, banter, fenStack: fenStack.slice(-200) };
  saveSettings(next).catch(() => {});
}

// ---------------- 对外 ----------------
export function newGame() {
  game = new Game();
  fenStack = [game.exportFEN()];
  selected = null;
  lastMove = null;
  finished = false;
  busy = false;
  flipped = playerColor === 'black';
  refreshLegal();
  renderAll();
  persist();
  if (playerColor === 'black') maybeAiMove();
}

function undo() {
  if (fenStack.length <= 1) { toast(t('chess.noMoves')); return; }
  if (busy) return;
  fenStack.pop();
  game = new Game(fenStack[fenStack.length - 1]);
  let guard = 0;
  while (fenStack.length > 1 && board().turn !== playerColor && guard < 4) {
    fenStack.pop();
    game = new Game(fenStack[fenStack.length - 1]);
    guard += 1;
  }
  selected = null;
  finished = false;
  lastMove = null;
  refreshLegal();
  renderAll();
  persist();
}

export function openChessModal() {
  const c = getSettings().chess || {};
  level = c.level || 3;
  playerColor = c.playerColor === 'black' ? 'black' : 'white';
  banter = !!c.banter;
  el('chess-level').value = String(level);
  el('chess-banter').checked = banter;
  document.querySelectorAll('#chess-side-switch button').forEach((b) => b.classList.toggle('on', b.dataset.side === playerColor));
  const stack = Array.isArray(c.fenStack) ? c.fenStack.slice(-200) : [];
  if (stack.length) {
    fenStack = stack;
    try { game = new Game(stack[stack.length - 1]); } catch (err) { game = new Game(); fenStack = [game.exportFEN()]; }
  } else {
    game = new Game(START_FEN);
    fenStack = [game.exportFEN()];
  }
  flipped = playerColor === 'black';
  selected = null; lastMove = null; finished = false; busy = false;
  refreshLegal();
  renderAll();
  el('modal-chess').classList.remove('hidden');
}

export function bindChess() {
  if (bound) return;
  bound = true;
  el('chess-close').onclick = () => el('modal-chess').classList.add('hidden');
  el('chess-new').onclick = newGame;
  el('chess-undo').onclick = undo;
  el('chess-resign').onclick = () => { finished = true; renderStatus(); };
  el('chess-flip').onclick = () => { flipped = !flipped; renderBoard(); };
  el('chess-level').onchange = (e) => { level = parseInt(e.target.value, 10) || 3; persist(); };
  el('chess-banter').onchange = (e) => { banter = e.target.checked; persist(); };
  document.querySelectorAll('#chess-side-switch button').forEach((b) => {
    b.onclick = () => {
      playerColor = b.dataset.side === 'black' ? 'black' : 'white';
      document.querySelectorAll('#chess-side-switch button').forEach((x) => x.classList.toggle('on', x === b));
      newGame();
    };
  });
}

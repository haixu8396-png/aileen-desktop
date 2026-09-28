// ============================================================
// 回复节奏控制
//
// 角色不该永远「一整段一次吐完」。有时候它应该：
//   · 先飞快回一句，再补一句
//   · 停两秒，像是在想
//   · 一句话说完顿一下，才说出后半句
//
// 模型用 <{'|'}delay:秒数{'|'}> 表达这种停顿。收到之后要：
//   1) 把当前这段收尾成一条独立消息
//   2) 真的等一会儿
//   3) 后续内容开一条新消息继续
//
// 难点：streamChat 的 onDelta 是同步回调，不能在里面 await。
// 所以这里做一个队列 + 异步消费：onDelta 只负责塞队列，
// 由消费循环串行处理，碰到 delay 就 sleep。这样既不阻塞 SSE 读取，
// 又能让「暂停」真的发生。
// ============================================================
import { createMarkerParser } from './marker-parser.js';

export const DELAY_KINDS = ['delay', 'wait', 'pause'];
export const MIN_DELAY = 0.2;
export const MAX_DELAY = 8;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clampDelay(sec) {
  const n = parseFloat(sec);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_DELAY, Math.max(MIN_DELAY, n));
}

/**
 * @param {object} o
 * @param {(s:string)=>void} o.onText  正文分片
 * @param {(m:object)=>void} o.onStage 动作/表情标记
 * @param {()=>void} [o.onBreak]       一段结束（该收尾当前消息、准备新消息）
 * @param {(sec:number)=>void} [o.onDelay] 即将停顿
 * @param {(ms:number)=>Promise<void>} [o.sleep] 便于测试注入
 */
export function createReplyPacer(o = {}) {
  const onText = typeof o.onText === 'function' ? o.onText : () => {};
  const onStage = typeof o.onStage === 'function' ? o.onStage : () => {};
  const onBreak = typeof o.onBreak === 'function' ? o.onBreak : () => {};
  const onDelay = typeof o.onDelay === 'function' ? o.onDelay : () => {};
  const sleep = typeof o.sleep === 'function' ? o.sleep : defaultSleep;

  const queue = [];
  let running = false;
  let ended = false;
  let resolveDone = null;
  const done = new Promise((r) => { resolveDone = r; });

  const parser = createMarkerParser({
    onText: (s) => onText(s),
    onMarker: (m) => {
      if (m && DELAY_KINDS.indexOf(m.kind) >= 0) {
        queue.push({ delay: clampDelay(m.value) });
        return;
      }
      onStage(m);
    },
  });

  async function drain() {
    if (running) return;
    running = true;
    while (queue.length) {
      const item = queue.shift();
      if (item.delay != null) {
        onBreak(item.delay);
        onDelay(item.delay);
        await sleep(item.delay * 1000);
        continue;
      }
      parser.push(item.text);
    }
    running = false;
    if (ended) {
      parser.end();
      if (resolveDone) { resolveDone(); resolveDone = null; }
    }
  }

  return {
    push(chunk) {
      if (ended) return;
      const s = String(chunk == null ? '' : chunk);
      if (!s) return;
      queue.push({ text: s });
      drain();
    },
    async finish() {
      if (!ended) {
        ended = true;
        await drain();
      }
      return done;
    },
  };
}

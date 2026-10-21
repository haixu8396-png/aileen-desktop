// ============================================================
// 高频事件的合并器（拖拽专用）
//
// 为什么单独写一层：拖动时 `pointermove` 每秒能来上百个，而每个事件都要跟主进程
// 说一次「窗口挪到这儿」。不合并的话：
//   · IPC 无上限并发，消息越排越长 —— 真机表现就是「拖不动 / 越拖越卡」；
//   · 松开鼠标之后队列里还剩几十个过时的位置，窗口会继续「飘」一段；
//   · 每个事件一个窗口调用，主进程被灌满，重绘也跟着掉帧。
//
// 这里的策略（三条，缺一不可）：
//   1. 一帧最多发一次（用 rAF 合并同一帧里的所有事件）；
//   2. 同一时刻只允许一个调用在途，在途期间只记「还有新的」这一个布尔值
//      —— 不排队、不留历史位置，永远只发最新的一次；
//   3. end() 之后立刻作废待发的帧和排队标记，并且在途调用回来也不会再发。
//
// 依赖全部注入（call / schedule / cancel），所以它能被单测完整覆盖，
// 不需要真窗口、也不需要真的 rAF。
// ============================================================

export function createDragCoalescer({ call, schedule, cancel } = {}) {
  if (typeof call !== 'function') throw new Error('createDragCoalescer 需要 call 函数');
  const requestFrame = typeof schedule === 'function'
    ? schedule
    : (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));
  const cancelFrame = typeof cancel === 'function'
    ? cancel
    : (h) => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(h);
      else clearTimeout(h);
    };

  let active = false;
  let frame = 0;
  let inFlight = false;
  let queued = false;
  let calls = 0;
  let dropped = 0;

  function flush() {
    if (!active) return;
    if (inFlight) { queued = true; return; }   // 只记「待会儿还要再发一次」
    inFlight = true;
    calls += 1;
    let result;
    try {
      result = call();
    } catch (err) {
      result = Promise.reject(err);
    }
    Promise.resolve(result)
      .catch(() => { /* 窗口可能已经销毁：拖动这件事不值得抛错 */ })
      .then(() => {
        inFlight = false;
        if (queued) {
          queued = false;
          if (active) flush();
        }
      });
  }

  return {
    /** 开始一次拖动：之后 request() 才会真的发调用 */
    start() {
      active = true;
      queued = false;
    },
    /** 收到一个高频事件：同一帧内只排一次 */
    request() {
      if (!active) return;
      if (frame) { dropped += 1; return; }
      frame = requestFrame(() => {
        frame = 0;
        flush();
      });
    },
    /** 结束拖动：作废待发帧、清掉排队标记，之后 request() 一律忽略 */
    end() {
      active = false;
      queued = false;
      if (frame) {
        try { cancelFrame(frame); } catch (err) { /* ignore */ }
        frame = 0;
      }
    },
    /** 自检 / 统计用 */
    stats() {
      return { active, pending: !!frame, inFlight, queued, calls, dropped };
    },
  };
}

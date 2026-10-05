// ============================================================
// 代际令牌（generation token）—— 用来让「过期的异步回调」失效
//
// 解决的问题（这一类 bug 都长一个样）：
//   · 用户点了停止/取消，但之前发出的请求回来又把状态改了；
//   · 上一次的定时器到期，把已经结束的循环重新拉起来；
//   · 连续点两次「开始」，起了两个循环互相打架。
//
// 做法只有一条规矩：**每次开始/停止都换号，回调动状态之前先确认自己还是当前号**。
// 手写 `if (stillRunning)` 是不够的 —— 那个标志位可能已经被下一次开始重新置成 true，
// 旧回调就会以为自己合法。号是单调递增的，不会出现这种「复用」。
//
// 这是纯逻辑（不碰 DOM、不碰定时器），所以可以单测。
// ============================================================

export function createGeneration(initial = 0) {
  let gen = initial;
  let active = false;
  const timers = new Set();

  return {
    /** 取当前号：回调应该在最开始抓住它，之后用它判断自己是否过期 */
    current: () => gen,
    isActive: () => active,

    /** 开始一代（如果已经 active 则返回 null —— 调用方据此拒绝「重复开始」） */
    begin() {
      if (active) return null;
      gen += 1;
      active = true;
      return gen;
    },

    /**
     * 结束当前代。
     * 返回被清掉的定时器数量（便于断言「停止真的清干净了」）。
     */
    end(clearFn) {
      gen += 1;
      active = false;
      let cleared = 0;
      for (const entry of timers) {
        timers.delete(entry);
        const fn = (entry && entry.clearFn) || clearFn;
        if (typeof fn === 'function') { fn(entry && entry.id != null ? entry.id : entry); cleared += 1; }
      }
      return cleared;
    },

    /** 这个号还是当前代、且循环仍在跑吗 */
    isCurrent(token) {
      return token === gen && active;
    },

    /**
     * 排一个「只在仍是当前代时才执行」的定时器。
     * @returns {*} 定时器句柄（同时登记在案，end() 时会清掉）
     */
    schedule(fn, ms, setTimeoutFn, clearTimeoutFn) {
      const token = gen;
      const id = setTimeoutFn(() => {
        timers.delete(id);
        if (token !== gen) return;    // 过期：丢掉，绝不碰状态
        fn();
      }, ms);
      // 存成 {id, clearFn} 以便 end() 用正确的清理函数
      timers.add({ id, clearFn: clearTimeoutFn });
      return id;
    },

    /**
     * 把一个**外部创建**的定时器纳入本代管理：
     * 停止时会被一起清掉，回调里也能用 isCurrent 判断是否过期。
     * 用途：像「等 TTS 空闲」这种用 setInterval + 兜底 setTimeout 组合的场景。
     */
    adopt(id, clearFn) {
      if (id == null) return id;
      timers.add({ id, clearFn });
      return id;
    },

    pendingCount: () => timers.size,
  };
}

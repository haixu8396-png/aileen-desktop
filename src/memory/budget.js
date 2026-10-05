// ============================================================
// Context Budget：给检索结果估算 token
//
// 为什么不用真 tokenizer：那是模型相关的（BPE 词表几千行），
// 要么加依赖，要么把词表打进仓库 —— 两条都违反「零新依赖」。
// 记忆进上下文的用途是「给模型一点背景」，**估算偏保守**（宁可少放两条，
// 也不要超预算把对话挤掉）就足够。
//
// 估算依据（保守取值）：
//   · CJK（中日文）：**1 字 ≈ 1 token**。GPT 系对中文普遍是 1 字 1~1.5 token，
//     取 1 是下界，所以估算只会偏少 —— 于是再乘一个 1.15 的安全系数。
//   · 拉丁字母/数字：**4 字符 ≈ 1 token**（英文常见 3.5~4），向上取整。
//   · 标点/符号：并入相邻字符段一起算（不再单独加，避免重复计数）。
//   · 每条记忆另加固定开销 4 token（分隔符、序号、角色标注等）。
// 这个函数的**唯一用途是裁剪**，不保证与实际 tokenizer 一致。
// ============================================================

/** 每条记忆的固定包装开销（拼接时的分隔符/前缀） */
export const PER_MEMORY_OVERHEAD_TOKENS = 4;

/** 安全系数：估算取的是下界，乘上去更接近真实占用 */
export const SAFETY_FACTOR = 1.15;

/** `search()` 的默认预算：约 800 token ≈ 二三十条短记忆，够用又不挤占对话 */
export const DEFAULT_BUDGET_TOKENS = 800;

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;
const LATIN_RUN_RE = /[A-Za-z0-9]+/g;

/**
 * 保守估算文本 token 数。
 * @param {string} text
 * @returns {number} 整数 token 估算（空文本为 0）
 */
export function estimateTokens(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;

  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (CJK_RE.test(ch)) cjk += 1;
    else other += 1;
  }

  // 拉丁/数字按「连续段长度 / 4 向上取整」累加
  let latinTokens = 0;
  const runs = s.match(LATIN_RUN_RE) || [];
  for (const run of runs) latinTokens += Math.ceil(run.length / 4);

  // 剩下的非 CJK、非拉丁字符（空格、标点）按 1/4 折算，避免完全忽略
  const restChars = Math.max(0, other - runs.reduce((n, r) => n + r.length, 0));
  const restTokens = Math.ceil(restChars / 4);

  const raw = cjk + latinTokens + restTokens;
  return Math.ceil(raw * SAFETY_FACTOR);
}

/**
 * 一条记忆在上下文里的估算开销（内容 + 包装）。
 *
 * 兼容两种形状：直接给记录（{content}）或给精排后的条目（{record:{content}}）。
 * **必须兼容后者**：检索流程从 rerank 拿到的就是包装过的条目，
 * 早期只读 item.content 会拿到 undefined → 每条都算 0 token →
 * 预算永远不裁（`budgetTokens` 形同虚设，有测试抓到过）。
 */
export function estimateMemoryTokens(record) {
  if (!record) return 0;
  const content = typeof record.content === 'string'
    ? record.content
    : (record.record && record.record.content);
  return estimateTokens(content) + PER_MEMORY_OVERHEAD_TOKENS;
}

/**
 * 按预算裁剪（输入已按分数降序）。
 *
 * 策略：**从高分往低分放，放不下就跳过它**。为什么不「从尾巴一路砍」：
 * 尾部那条可能很便宜，砍掉它预算仍然不够，于是又要砍第二条 ——
 * 结果一条都不放，而实际上单独一条高分记忆是放得下的。
 * 从高分开始贪心则保证「最该进上下文的先进」，被跳过的会如实回报在 dropped 里。
 *
 * 例外：如果**连最高分那条都超预算**，会返回空结果（dropped 里能看到它）——
 * 宁可什么都不给，也不要把预算撑爆（超预算是硬约束，调用方按它分配上下文）。
 *
 * @param {Array} ranked 已按分数降序排好的结果（每项需带 content）
 * @param {number} budgetTokens 预算；<=0 或非数字时用默认值
 * @returns {{ kept:Array, dropped:Array, usedTokens:number, budgetTokens:number }}
 */
export function fitToBudget(ranked, budgetTokens = DEFAULT_BUDGET_TOKENS) {
  const budget = Number.isFinite(budgetTokens) && budgetTokens > 0
    ? Math.floor(budgetTokens)
    : DEFAULT_BUDGET_TOKENS;
  const list = Array.isArray(ranked) ? ranked.slice() : [];
  const kept = [];
  const dropped = [];
  let used = 0;

  for (const item of list) {
    const cost = estimateMemoryTokens(item);
    if (used + cost <= budget) {
      kept.push(item);
      used += cost;
    } else {
      dropped.push(item);
    }
  }
  return { kept, dropped, usedTokens: used, budgetTokens: budget };
}

/** 保守估算整段记忆数组的 token 总量（stats / 调试用） */
export function estimateTotal(records) {
  return (Array.isArray(records) ? records : [])
    .reduce((sum, r) => sum + estimateMemoryTokens(r), 0);
}

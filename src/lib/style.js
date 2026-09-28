// ============================================================
// 表演风格的提示词组装
//
// 两件事都要「可调」，而且不能做成一个开关就完事：
//   · 括号里的动作 / 心理活动：不写 / 极少 / 自然 / 较多
//   · 回复节奏（带停顿拆成多条）：不用 / 极少 / 自然
//
// 注意 natural 档也必须给指令：得告诉模型「可以写但别每条都写」，
// 只对 off 档写「不要」，模型才会真的收敛到用户想要的位置。
// ============================================================
import { t } from './i18n.js';

export const NARRATION_LEVELS = ['off', 'rare', 'natural', 'rich'];
export const PACING_LEVELS = ['off', 'rare', 'natural'];

/** 组装风格指令，返回若干段（调用方再拼上形象控制那一段） */
export function buildStyleInstruction(behavior) {
  const b = behavior || {};
  const narr = NARRATION_LEVELS.indexOf(b.narration) >= 0 ? b.narration : 'natural';
  const pace = PACING_LEVELS.indexOf(b.pacing) >= 0 ? b.pacing : 'natural';
  const parts = [t('prompt.narration.' + narr)];
  if (pace === 'off') {
    parts.push(t('prompt.pacing.off'));
  } else {
    parts.push(t('prompt.pacing'));
    if (pace === 'rare') parts.push(t('prompt.pacing.rareNote'));
  }
  return parts;
}

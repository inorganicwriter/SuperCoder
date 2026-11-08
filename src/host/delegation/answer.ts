/**
 * 答案选择。遵循架构设计规范。
 *
 * 显式优先级链，每个 provider 都按这条链声明自己的阶段名：
 *
 * | 观察到的 phase     | 处理                                  |
 * |--------------------|---------------------------------------|
 * | `final_answer`     | 采纳并立即结束                        |
 * | `partial_answer`   | 记为候选；之后若还有工具调用则作废    |
 * | `null`             | 兼容候选（旧版本没有 phase 字段）     |
 * | `commentary`       | 跳过：那是过程话，不是结果            |
 * | 其它               | `invalid-result`：整轮判失败          |
 *
 * 无有效候选答案时返回 invalid-result，明确表示未匹配到结果。
 */

export interface AnswerCandidate {
  readonly phase: string | null;
  readonly text: string;
  /** 这条候选之后是否还发生过工具调用（provider 观测得出）。 */
  readonly toolCallAfter?: boolean;
}

export type AnswerSelection =
  | { readonly ok: true; readonly answer: string }
  | { readonly ok: false; readonly category: "invalid-result"; readonly detail: string };

export interface AnswerPhaseChain {
  readonly final: string;
  readonly partial: string;
  readonly commentary: string;
}

export const DEFAULT_ANSWER_CHAIN: AnswerPhaseChain = {
  final: "final_answer",
  partial: "partial_answer",
  commentary: "commentary",
};

/** 候选的等级：只有更高等级能覆盖已有候选。 */
const RANK_PARTIAL = 2;
const RANK_NULL = 1;

export function selectAnswer(
  candidates: readonly AnswerCandidate[],
  chain: AnswerPhaseChain = DEFAULT_ANSWER_CHAIN,
): AnswerSelection {
  let best: AnswerCandidate | null = null;
  // 显式分级：final_answer > partial_answer > null（兼容候选）。只有更高等级能覆盖 best，
  // 同级之间后写覆盖先写（多条 null 时取信息最全的最后一条）。
  let bestRank = 0;

  for (const candidate of candidates) {
    const phase = candidate.phase;
    if (phase === null) {
      // 旧版本兼容候选：只能当"没有更好选择时的备胎"。
      if (bestRank <= RANK_NULL) {
        best = candidate;
        bestRank = RANK_NULL;
      }
      continue;
    }
    if (phase === chain.commentary) continue;
    if (phase === chain.final) {
      return { ok: true, answer: candidate.text };
    }
    if (phase === chain.partial) {
      if (bestRank <= RANK_PARTIAL) {
        best = candidate;
        bestRank = RANK_PARTIAL;
      }
      continue;
    }
    return {
      ok: false,
      category: "invalid-result",
      detail: `收到未识别的执行阶段：${JSON.stringify(phase)}。`,
    };
  }

  if (best !== null) {
    // 这条规则只写在 partial_answer 名下：兼容候选不带这个语义。
    if (bestRank === RANK_PARTIAL && best.toolCallAfter === true) {
      return {
        ok: false,
        category: "invalid-result",
        detail: "仅存在中间答案且后续存在工具调用，无法作为最终结果。",
      };
    }
    if (best.text.trim() === "") {
      return {
        ok: false,
        category: "invalid-result",
        detail: "候选执行答案为空。",
      };
    }
    return { ok: true, answer: best.text };
  }

  return {
    ok: false,
    category: "invalid-result",
    detail: "未获取到执行结果答案。",
  };
}

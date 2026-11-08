/**
 * 提问与回答。遵循架构设计规范（ask_user_decision）。
 *
 * 与审批同构：先落 `question/asked`，等人答，答了落 `question/answered`。
 * 进程重启后旧问题不会自动重放——它是历史，不是待办。
 */

import { randomUUID } from "node:crypto";
import type { SessionHandle } from "../session/handle.js";
import type { Logger } from "../boot/logger.js";

interface PendingQuestion {
  readonly session: SessionHandle;
  readonly resolve: (answer: string | null) => void;
  readonly cleanup: () => void;
}

export class QuestionBroker {
  private readonly pending = new Map<string, PendingQuestion>();

  constructor(private readonly logger: Logger) {}

  ask(input: {
    readonly session: SessionHandle;
    readonly question: string;
    readonly options: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<string | null> {
    const questionId = `q_${randomUUID()}`;
    input.session.append("question/asked", {
      questionId,
      question: input.question,
      options: [...input.options],
    });
    return new Promise<string | null>((resolve) => {
      const onAbort = (): void => {
        this.pending.delete(questionId);
        resolve(null);
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(questionId, {
        session: input.session,
        resolve: (answer) => {
          input.signal.removeEventListener("abort", onAbort);
          resolve(answer);
        },
        cleanup: () => input.signal.removeEventListener("abort", onAbort),
      });
    });
  }

  /** 来自 `question.answer` 的回答。返回是否命中。 */
  answer(questionId: string, answer: string): boolean {
    const entry = this.pending.get(questionId);
    if (entry === undefined) return false;
    this.pending.delete(questionId);
    entry.cleanup();
    entry.session.append("question/answered", { questionId, answer });
    entry.resolve(answer);
    return true;
  }

  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  get waiting(): number {
    return this.pending.size;
  }

  reset(): void {
    for (const [id, entry] of this.pending) {
      entry.cleanup();
      entry.resolve(null);
      this.logger.debug({ questionId: id }, "关闭时丢弃未回答的问题");
    }
    this.pending.clear();
  }
}

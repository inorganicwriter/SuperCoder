/**
 * 回合调度。遵循架构设计规范（message.send / turn.interrupt）。
 *
 * `message.send` 立刻返回 turnId，之后全靠事件推进（前端订阅）。
 * 一个会话同时只有一个回合（C4）：第二次发送直接 busy。
 */

import { randomUUID } from "node:crypto";
import type { SessionHandle } from "../session/handle.js";
import type { Logger } from "../boot/logger.js";
import { fail } from "../boot/failure.js";
import type { ModelCatalog } from "../models/catalog.js";
import type { ApprovalBroker, Decision, RememberScope } from "../tools/approval.js";
import type { ToolPipeline } from "../tools/pipeline.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { QuestionBroker } from "./questions.js";
import { TurnRunner, type TurnStatus } from "./turn.js";

export interface AgentHubDeps {
  readonly models: ModelCatalog;
  readonly tools: ToolPipeline;
  readonly registry: ToolRegistry;
  readonly approvals: ApprovalBroker;
  readonly questions: QuestionBroker;
  readonly logger: Logger;
  readonly language: () => "zh-CN" | "en";
  readonly workspacePathOf: (session: SessionHandle) => string;
  readonly maxSteps?: number;
  /** 本工作区其它对话保存的共享上下文，见 TurnDeps.sharedContext。 */
  readonly sharedContext?: (session: SessionHandle) => string;
}

export interface SendInput {
  readonly session: SessionHandle;
  readonly text: string;
  readonly attachments: readonly string[];
  readonly modelId?: string;
}

export class AgentHub {
  private readonly controllers = new Map<string, AbortController>();
  private readonly runs = new Map<string, Promise<TurnStatus>>();

  constructor(private readonly deps: AgentHubDeps) {}

  send(input: SendInput): { turnId: string } {
    const { session } = input;
    const turnId = `turn_${randomUUID()}`;
    if (input.text.trim() === "") {
      fail("invalid_params", "消息内容不能为空。");
    }
    // 没有模型档案就不开回合：必须在 beginTurn 之前判定，否则会话会停在"正在执行"。
    const modelId = input.modelId ?? this.deps.models.defaultModelId;
    if (modelId === null) {
      fail("denied", "未配置模型，请在侧栏「模型管理」中添加模型并配置密钥。");
    }
    // beginTurn 在忙时会抛 busy（C4）。
    session.beginTurn(turnId);
    const controller = new AbortController();
    this.controllers.set(turnId, controller);

    const runner = new TurnRunner({
      models: this.deps.models,
      tools: this.deps.tools,
      registry: this.deps.registry,
      approvals: this.deps.approvals,
      logger: this.deps.logger,
      language: this.deps.language,
      workspacePath: () => this.deps.workspacePathOf(session),
      ...(this.deps.sharedContext === undefined ? {} : { sharedContext: this.deps.sharedContext }),
      ...(this.deps.maxSteps === undefined ? {} : { maxSteps: this.deps.maxSteps }),
    });

    const run = runner
      .run({
        session,
        turnId,
        text: input.text,
        attachments: input.attachments,
        modelId,
        signal: controller.signal,
      })
      .catch((error: unknown) => {
        this.deps.logger.error({ error, turnId }, "回合失败");
        return "unknown" as TurnStatus;
      })
      .finally(() => {
        this.controllers.delete(turnId);
        session.endTurn();
        session.writeIndex();
        this.runs.delete(turnId);
      });

    this.runs.set(turnId, run);
    return { turnId };
  }

  /**
   * 等一个回合跑完：只给测试与诊断用，界面不靠它。
   *
   * 查不到就是查不到：编一个 "completed" 会让调用方以为对话正常结束了（P2-6）。
   * 回合跑完会被 `finally` 从 runs 里摘掉，所以"跑完再问"同样是 not_found。
   */
  async waitTurn(turnId: string): Promise<TurnStatus> {
    const run = this.runs.get(turnId);
    if (run === undefined) {
      fail("not_found", `未找到正在执行的回合 ${turnId}。`);
    }
    return await run;
  }

  /**
   * 中断回合。turnId 为空表示"这个会话当前正在跑的那一轮"：界面切换会话或刷新后
   * 不再持有发消息时拿到的 turnId，但仍然要能打断。
   */
  interrupt(session: SessionHandle, requested: string): void {
    const turnId = requested === "" ? session.currentTurnId ?? "" : requested;
    if (turnId === "") fail("not_found", "当前会话没有正在执行的回合。");
    const controller = this.controllers.get(turnId);
    if (controller === undefined) {
      fail("not_found", `未找到正在执行的回合 ${turnId}。`);
    }
    if (session.currentTurnId !== turnId) {
      fail("invalid_params", `回合 ${turnId} 不属于当前会话。`);
    }
    controller.abort();
  }

  respondApproval(callId: string, decision: Decision, remember: RememberScope): void {
    const hit = this.deps.approvals.respond(callId, decision, remember);
    if (!hit) {
      fail("not_found", `未找到待审批的调用 ${callId}。`);
    }
  }

  answerQuestion(questionId: string, answer: string): void {
    const hit = this.deps.questions.answer(questionId, answer);
    if (!hit) {
      fail("not_found", `未找到待回答的问题 ${questionId}。`);
    }
  }

  /** 退出前收尾：中断所有回合、丢弃未回答的问题。 */
  shutdown(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.deps.questions.reset();
  }

  get activeTurns(): number {
    return this.controllers.size;
  }
}

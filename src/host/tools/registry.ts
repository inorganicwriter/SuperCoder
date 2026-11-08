/**
 * 工具注册表。遵循架构设计规范。
 *
 * 注册表提供两端一致的规范定义：模型侧工具声明与运行时参数校验共用同一份 zod schema。
 */

import { z } from "zod";
import type { BuiltinToolName, BuiltinToolSpec } from "../../shared/domain/builtin-tools.js";
import type { ToolOutcome } from "../../shared/domain/tool.js";
import type { SessionHandle } from "../session/handle.js";
import { jsonSchemaOf, type LlmToolSpec } from "../models/llm.js";

export interface ToolContext {
  readonly session: SessionHandle;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly mode: "read-only" | "write";
  readonly signal: AbortSignal;
}

export type ToolExecutor = (args: unknown, ctx: ToolContext) => Promise<ToolOutcome>;

export interface RegisteredTool {
  readonly spec: BuiltinToolSpec;
  readonly execute: ToolExecutor;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(spec: BuiltinToolSpec, execute: ToolExecutor): void {
    if (this.tools.has(spec.name)) throw new Error(`工具重复注册：${spec.name}`);
    this.tools.set(spec.name, { spec, execute });
  }

  get(name: string): RegisteredTool | null {
    return this.tools.get(name) ?? null;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  builtinNames(): BuiltinToolName[] {
    return [...this.tools.keys()] as BuiltinToolName[];
  }

  isMutating(name: string): boolean {
    return this.tools.get(name)?.spec.mutating ?? false;
  }

  /** 模型侧的工具清单：参数走 zod → JSON Schema。 */
  specs(): LlmToolSpec[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.spec.name,
      description: tool.spec.description,
      parameters: jsonSchemaOf(tool.spec.params),
    }));
  }

  /** 执行侧的参数校验。失败信息要能直接回给模型看。 */
  parseArgs(name: string, raw: unknown):
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly message: string } {
    const tool = this.get(name);
    if (tool === null) return { ok: false, message: `没有这个工具：${name}` };
    const parsed = (tool.spec.params as z.ZodTypeAny).safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      return { ok: false, message: `${name} 参数不符：${issues}` };
    }
    return { ok: true, value: parsed.data };
  }
}

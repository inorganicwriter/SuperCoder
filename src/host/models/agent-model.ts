/**
 * Agent 的模型选择：`profile:<id>` → API 配置。遵循架构设计规范。
 *
 * 两件事分开：
 * - `agentModelConfig` 解析配置，配置不对就抛 `RpcFailure`（调用方在同步路径上用它）；
 * - `checkAgentModel` 把同一次解析的结果折成可以返回的值，供工具层在**开跑之前**校验。
 *
 * 任务分派前的校验必须发生在执行体之前：`ToolPipeline` 把执行体里抛出的异常统一记成
 * `uncertain`（会有副作用，只能记未知态）。模型档案被删是纯配置问题，什么都没跑，
 * 落到 `uncertain` 会让人去工作区找根本不存在的副作用。
 */

import { fail, isRpcFailure } from "../boot/failure.js";
import type { SecretStore } from "../boot/secrets.js";
import type { AgentModelConfig } from "../../shared/domain/delegation.js";
import { secretKeyOf, type ModelCatalog } from "./catalog.js";

export interface AgentModelDeps {
  readonly models: ModelCatalog;
  readonly secrets: SecretStore;
}

/** 支持"用 SuperCoder 模型档案"的 Agent；其它 Agent 只认自己的原生模型名。 */
const PROFILE_CAPABLE_AGENTS = new Set(["codex", "opencode", "deepseek-harness"]);

const PROFILE_PREFIX = "profile:";

export type AgentModelCheck =
  | { readonly status: "ok" }
  | { readonly status: "error"; readonly code: "invalid_args" | "denied"; readonly message: string };

/**
 * 解析 Agent 的模型配置。
 *
 * `selection` 是原生模型名（不返回配置）或 `profile:<id>`（返回 API 凭据）。
 * 凭据只在这里出现，不写进日志与事件。
 */
export function agentModelConfig(
  agentId: string,
  selection: string | undefined,
  deps: AgentModelDeps,
): AgentModelConfig | undefined {
  if (selection?.startsWith(PROFILE_PREFIX) !== true) return undefined;
  if (!PROFILE_CAPABLE_AGENTS.has(agentId)) {
    fail("denied", "当前 Agent 暂不支持使用 SuperCoder 的 API 模型档案。");
  }
  const profileId = selection.slice(PROFILE_PREFIX.length);
  const profile = deps.models.get(profileId);
  if (profile.kind !== "openai-compatible" && profile.kind !== "deepseek") {
    fail("invalid_params", "该 Agent 只支持 OpenAI 兼容的 API 档案。");
  }
  let url: URL;
  try {
    url = new URL(profile.baseUrl);
  } catch {
    return fail("invalid_params", "模型 API 地址无效。");
  }
  const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback) {
    fail("denied", "远程模型 API 必须使用 HTTPS。");
  }
  if (url.username || url.password || url.search || url.hash) {
    fail("invalid_params", "模型 API 地址不能包含凭据、查询参数或片段。");
  }
  const apiKey = deps.secrets.get(secretKeyOf(profile));
  if (apiKey === null || apiKey.trim() === "") {
    fail("denied", "所选模型档案未配置密钥，请在「模型管理」中填写密钥。");
  }
  return { baseUrl: profile.baseUrl, model: profile.model, apiKey };
}

/**
 * 任务派发前的模型有效性校验：配置问题折成返回值，不再以异常形式穿过执行体。
 *
 * 档案被删的提示要点明"是哪个档案没了"，否则用户只看到一串 id。
 */
export function checkAgentModel(
  agentId: string,
  selection: string | undefined,
  deps: AgentModelDeps,
): AgentModelCheck {
  try {
    agentModelConfig(agentId, selection, deps);
    return { status: "ok" };
  } catch (error) {
    if (!isRpcFailure(error)) throw error;
    const profileId = selection?.startsWith(PROFILE_PREFIX) === true ? selection.slice(PROFILE_PREFIX.length) : null;
    if (error.code === "not_found" && profileId !== null) {
      return {
        status: "error",
        code: "invalid_args",
        message: `所选模型档案已删除（${profileId}），请在设置中重新选择可用模型。`,
      };
    }
    return {
      status: "error",
      code: error.code === "denied" ? "denied" : "invalid_args",
      message: error.message,
    };
  }
}

import type { DelegationRequest } from "../../shared/domain/delegation.js";

/**
 * 把任务原样交给 Agent。不追加只读/可写之类的说明：权限由宿主按各家接入的原生模式处理，
 * 写进正文只会占 Agent 的上下文。用户原话留在任务日志里，不重复附加。
 */
export function buildDelegationPrompt(request: DelegationRequest): string {
  return request.instruction.trim() === "" ? request.goal : request.instruction;
}

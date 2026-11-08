/**
 * 帧格式。遵循架构设计规范。
 *
 * 校验点落在跨进程消息上（C5）：两端都用这里的 schema 解析，不信任对方。
 */

import { z } from "zod";
import { ErrorCodeSchema, type ErrorCode } from "./errors.js";
import { SessionEventSchema, type SessionEvent } from "../session/events.js";

export type RpcRequest = { kind: "rpc"; rpcId: string; method: string; params: unknown };
export type EventSubscribe = { kind: "subscribe"; sessionId: string; sinceSeq: number };
export type ClientFrame = RpcRequest | EventSubscribe;

export type RpcResponse =
  | { kind: "result"; rpcId: string; ok: true; result: unknown }
  | { kind: "result"; rpcId: string; ok: false; error: { code: ErrorCode; message: string } };

export type EventFrame = { kind: "events"; sessionId: string; events: SessionEvent[] };
export type ServerFrame = RpcResponse | EventFrame;

export const RpcRequestSchema = z.object({
  kind: z.literal("rpc"),
  rpcId: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown(),
});

export const EventSubscribeSchema = z.object({
  kind: z.literal("subscribe"),
  sessionId: z.string().min(1),
  sinceSeq: z.number().int().nonnegative(),
});

export const ClientFrameSchema = z.union([RpcRequestSchema, EventSubscribeSchema]);

export const RpcErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
});

export const RpcResponseSchema = z.union([
  z.object({
    kind: z.literal("result"),
    rpcId: z.string(),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    kind: z.literal("result"),
    rpcId: z.string(),
    ok: z.literal(false),
    error: RpcErrorSchema,
  }),
]);

export const EventFrameSchema = z.object({
  kind: z.literal("events"),
  sessionId: z.string(),
  events: z.array(SessionEventSchema),
});

export const ServerFrameSchema = z.union([RpcResponseSchema, EventFrameSchema]);

/** 补发上限：一批 ≤ 200 条。 */
export const EVENT_BATCH_LIMIT = 200;

export function resultOk(rpcId: string, result: unknown): RpcResponse {
  return { kind: "result", rpcId, ok: true, result };
}

export function resultErr(rpcId: string, code: ErrorCode, message: string): RpcResponse {
  return { kind: "result", rpcId, ok: false, error: { code, message } };
}

export function eventFrame(sessionId: string, events: SessionEvent[]): EventFrame {
  return { kind: "events", sessionId, events };
}

export function isRpcRequest(frame: ClientFrame): frame is RpcRequest {
  return frame.kind === "rpc";
}

/**
 * MCP 的 OAuth 授权。遵循架构设计规范。
 *
 * 做法是最小可用：从 `/.well-known/oauth-authorization-server` 取授权端点，
 * 带 PKCE 生成授权 URL，让用户去浏览器点同意；token 回来后由 `secret.set` 存进 secrets.bin。
 *
 * 服务器没提供元数据就明确拒绝——不猜端点，也不假装已经授权。
 */

import { createHash, randomBytes } from "node:crypto";

export interface AuthorizationRequest {
  readonly url: string;
  readonly state: string;
  readonly verifier: string;
}

export interface OAuthMetadata {
  readonly authorization_endpoint?: string;
  readonly token_endpoint?: string;
  readonly registration_endpoint?: string;
}

export const OAUTH_REDIRECT = "http://127.0.0.1/callback";
export const OAUTH_CLIENT_ID = "supercoder";

export async function buildAuthorizationUrl(
  target: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthorizationRequest> {
  let origin: string;
  try {
    origin = new URL(target).origin;
  } catch {
    throw new Error(`目标不是合法 URL：${target}。`);
  }

  let metadata: OAuthMetadata | null = null;
  try {
    const response = await fetchImpl(`${origin}/.well-known/oauth-authorization-server`, {
      headers: { accept: "application/json" },
    });
    if (response.ok) metadata = (await response.json()) as OAuthMetadata;
  } catch {
    metadata = null;
  }

  if (metadata?.authorization_endpoint === undefined) {
    throw new Error(
      `${origin} 没有提供 OAuth 授权元数据，请改用 stdio 方式接入或在配置中指定 Token。`,
    );
  }

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", OAUTH_REDIRECT);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), state, verifier };
}

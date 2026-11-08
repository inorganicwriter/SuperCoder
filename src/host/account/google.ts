/**
 * Google 登录的服务端半程：接授权码、换令牌、取昵称与邮箱。
 *
 * 为什么放在主进程：换令牌这一步要 POST 到 oauth2.googleapis.com，浏览器里做会被
 * CORS 挡掉，而且客户端密码（哪怕是被视为非机密的）也不该出现在渲染进程里。
 *
 * 授权码怎么回来：桌面应用的标准做法是"系统浏览器 + 环回重定向"。这里用
 * `http://127.0.0.1:<端口>/oauth/google/callback` 作 redirect_uri，回调把 code 放进
 * 内存里的待领取表，渲染进程再拿 state 来取。
 */

import { randomBytes } from "node:crypto";
import { messageOf } from "../boot/failure.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

/** 一次登录要占的 scope：只读基本资料与邮箱，都属于非敏感范围。 */
export const GOOGLE_SCOPE = "openid email profile";

/** 换回来的账号信息，字段名与界面一致。 */
export interface GoogleAccount {
  readonly name: string;
  readonly email: string;
  readonly picture: string | null;
}

/** 待领取的授权结果：成功给 code，失败给错误说明。 */
export interface PendingAuthorization {
  readonly code: string | null;
  readonly error: string | null;
  readonly at: number;
}

/** 授权码只活这么久，过时的不再给。 */
const PENDING_TTL_MS = 5 * 60 * 1000;

export interface PendingStore {
  put(state: string, value: PendingAuthorization): void;
  take(state: string): PendingAuthorization | null;
}

/** 新建一个待领取表。放内存里：登录是一次性的，重启即作废。 */
export function createPendingStore(now: () => number = Date.now): PendingStore {
  const items = new Map<string, PendingAuthorization>();
  return {
    put(state, value) {
      items.set(state, value);
    },
    take(state) {
      const found = items.get(state);
      if (found === undefined) return null;
      if (now() - found.at > PENDING_TTL_MS) {
        items.delete(state);
        return null;
      }
      items.delete(state);
      return found;
    },
  };
}

/** 授权地址：PKCE（S256），不传 client_secret。 */
export function buildAuthUrl(input: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly challenge: string;
}): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPE);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

/** 随便一个足够长的随机串，用作 state。 */
export function randomState(): string {
  return randomBytes(16).toString("base64url");
}

/** 把授权码换成账号信息。失败时抛出错误提示。 */
export async function exchangeCode(input: {
  readonly code: string;
  readonly verifier: string;
  readonly clientId: string;
  readonly redirectUri: string;
}): Promise<GoogleAccount> {
  let token: { access_token?: string; error?: string; error_description?: string };
  try {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: input.code,
        code_verifier: input.verifier,
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(20_000),
    });
    token = (await response.json()) as typeof token;
    if (!response.ok) {
      const reason = token.error_description ?? token.error ?? `HTTP ${String(response.status)}`;
      throw new Error(
        `Google 授权失败：${reason}。请确认客户端 ID 类型为「桌面应用」且重定向地址配置正确。`,
      );
    }
  } catch (error) {
    if (error instanceof Error && (error.message.includes("授权失败") || error.message.includes("Google"))) throw error;
    throw new Error(`无法连接 Google 令牌服务：${messageOf(error)}，请检查网络或代理设置。`);
  }
  const accessToken = token.access_token;
  if (accessToken === undefined || accessToken === "") {
    throw new Error("Google 未返回访问令牌，请重试登录。");
  }

  try {
    const response = await fetch(USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${String(response.status)}`);
    }
    const info = (await response.json()) as {
      name?: string;
      email?: string;
      picture?: string;
    };
    const email = info.email ?? "";
    return {
      name: info.name ?? (email === "" ? "Google 用户" : email.split("@")[0] ?? email),
      email,
      picture: info.picture ?? null,
    };
  } catch (error) {
    throw new Error(
      `获取账号资料失败：${messageOf(error)}，请确认 scope 包含 openid email profile。`,
    );
  }
}

/** 回调页：给人看的，说完就让人回应用。 */
export function callbackPage(result: { readonly ok: boolean; readonly reason: string }): string {
  const title = result.ok ? "登录完成" : "登录没有完成";
  const detail = result.ok ? "可以关掉这个页面，回到 SuperCoder 了。" : result.reason;
  const color = result.ok ? "#3F7A5E" : "#B4483C";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { margin: 0; display: grid; place-items: center; min-height: 100vh; background: #FAF9F5;
         color: #1F1E1C; font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  main { text-align: center; padding: 32px; }
  h1 { margin: 0 0 8px; font-size: 18px; font-weight: 500; color: ${color}; }
  p { margin: 0; color: #6B6862; }
</style></head>
<body><main><h1>${title}</h1><p>${detail}</p></main></body></html>`;
}

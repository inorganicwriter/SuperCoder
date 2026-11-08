/**
 * Google 登录的客户端半程：生成 PKCE、让系统浏览器去授权、轮询回跳结果、换令牌。
 *
 * 授权页一定要开在系统浏览器里：Google 不允许在嵌入式 webview 里走 OAuth
 * （会报 disallowed_useragent），Electron 的 window.open 属于嵌入式，所以走 IPC。
 */

import { t } from "../../locale/index.js";
import { readBootstrap } from "../../render/SessionProvider.js";

export interface GoogleResult {
  readonly name: string;
  readonly email: string;
  readonly picture: string | null;
}

/** 轮询多久放弃：人在浏览器里可能要点几下账号，给三分钟。 */
const POLL_TIMEOUT_MS = 3 * 60 * 1000;
const POLL_INTERVAL_MS = 1500;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE：64 字节随机串 + S256 挑战。 */
export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** 让主进程把链接交给系统浏览器。没有桥时返回 false，调用方给出提示。 */
export async function openExternal(url: string): Promise<boolean> {
  const bridge = (readBootstrap() as { openExternal?: (url: string) => Promise<boolean> } | null)
    ?.openExternal;
  if (typeof bridge !== "function") return false;
  try {
    return await bridge(url);
  } catch {
    return false;
  }
}

interface StartResponse {
  readonly state?: string;
  readonly authUrl?: string;
  readonly redirectUri?: string;
  readonly error?: string;
}

/** 完整的一次登录。失败时抛出错误提示。 */
export async function signInWithGoogle(input: {
  readonly clientId: string;
  readonly onStage: (stage: string) => void;
}): Promise<GoogleResult> {
  const bootstrap = readBootstrap();
  if (bootstrap === null) {
    throw new Error(t("account.errorNoBootstrap"));
  }
  const base = `http://127.0.0.1:${String(bootstrap.port)}`;
  const token = encodeURIComponent(bootstrap.token);

  const { verifier, challenge } = await createPkce();
  const started = await fetch(
    `${base}/oauth/google/start?clientId=${encodeURIComponent(input.clientId)}&port=${String(bootstrap.port)}&challenge=${challenge}`,
  );
  const start = (await started.json()) as StartResponse;
  if (!started.ok || start.authUrl === undefined || start.state === undefined) {
    throw new Error(start.error ?? t("account.errorStart"));
  }

  input.onStage(t("account.stageOpening"));
  const opened = await openExternal(start.authUrl);
  if (!opened) {
    throw new Error(
      t("account.errorNoBrowser"),
    );
  }

  input.onStage(t("account.stageWaiting"));
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let code: string | null = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const polled = await fetch(
      `${base}/oauth/google/pending?state=${encodeURIComponent(start.state)}&token=${token}`,
    );
    const pending = (await polled.json()) as { code?: string | null; error?: string | null };
    if (typeof pending.error === "string" && pending.error !== "") {
      throw new Error(pending.error);
    }
    if (typeof pending.code === "string" && pending.code !== "") {
      code = pending.code;
      break;
    }
  }
  if (code === null) {
    throw new Error(t("account.errorTimeout"));
  }

  input.onStage(t("account.stageExchange"));
  const exchanged = await fetch(`${base}/oauth/google/token?token=${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      verifier,
      clientId: input.clientId,
      redirectUri: start.redirectUri,
    }),
  });
  const body = (await exchanged.json()) as (GoogleResult & { error?: string }) | { error: string };
  if (!exchanged.ok || "error" in body) {
    const reason = "error" in body ? body.error : null;
    throw new Error(reason ?? t("account.errorExchange"));
  }
  return { name: body.name, email: body.email, picture: body.picture };
}

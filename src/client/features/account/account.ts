/**
 * 本机账户。这个版本没有服务端：登进来的身份只是"这台机器上记住的一个人"。
 *
 * 存放位置是渲染进程的 localStorage。Electron 的 userData 就是数据目录 home 本身，
 * 所以它落在 home\Local Storage 里（Chromium 自己的库里），不是我们能直接读的 JSON。
 * 换 home（SUPERCODER_HOME）等于换一份登录状态。退出登录就是把这条记录删掉。
 */

export interface Account {
  /** 显示名：Google 的 name，或本地填的昵称。 */
  readonly name: string;
  /** 邮箱；本地账户为空串。 */
  readonly email: string;
  /** 头像地址；本地账户为 null，界面用名字首字母。 */
  readonly picture: string | null;
  /** 来源：google 表示真的走过 OAuth，local 表示手填。 */
  readonly provider: "local" | "google";
}

const ACCOUNT_KEY = "sc.account";
const CLIENT_ID_KEY = "sc.google.clientId";

/** 读账户；没有或坏掉都当未登录。 */
export function readAccount(storage: Storage): Account | null {
  const raw = storage.getItem(ACCOUNT_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    if (name === "") return null;
    return {
      name,
      email: typeof record.email === "string" ? record.email : "",
      picture: typeof record.picture === "string" ? record.picture : null,
      provider: record.provider === "google" ? "google" : "local",
    };
  } catch {
    return null;
  }
}

export function writeAccount(storage: Storage, account: Account | null): void {
  if (account === null) {
    storage.removeItem(ACCOUNT_KEY);
    return;
  }
  storage.setItem(ACCOUNT_KEY, JSON.stringify(account));
}

/** Google OAuth 客户端 ID：由用户自己建，存在本机。 */
export function readClientId(storage: Storage): string {
  return storage.getItem(CLIENT_ID_KEY) ?? "";
}

export function writeClientId(storage: Storage, clientId: string): void {
  const trimmed = clientId.trim();
  if (trimmed === "") {
    storage.removeItem(CLIENT_ID_KEY);
    return;
  }
  storage.setItem(CLIENT_ID_KEY, trimmed);
}

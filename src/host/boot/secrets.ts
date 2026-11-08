/**
 * 凭据存储。遵循架构设计规范。
 *
 * 凭据必须经 safeStorage 加密；若系统加密能力不可用则拒绝保存，防止明文落盘。
 * 真正的加密后端由 Electron 主进程注入（`safeStorage`）；node 里跑测试时用内存后端。
 */

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { err, ok, type Result } from "../../shared/result.js";
import { writeJsonAtomic } from "./atomic.js";

export interface SecretBackend {
  readonly available: boolean;
  /** available 为 false 时说明原因（会原样展示给用户）。 */
  readonly reason?: string;
  encrypt(plaintext: string): string;
  decrypt(payload: string): string;
}

/** 测试与无 Electron 环境用：只做编码，不提供保密性，因此 `available` 也是 false。 */
export function createEphemeralBackend(): SecretBackend {
  return {
    available: false,
    reason: "当前环境没有可用的系统加密（Electron safeStorage），凭据不会落盘。",
    encrypt: (plaintext) => Buffer.from(plaintext, "utf8").toString("base64"),
    decrypt: (payload) => Buffer.from(payload, "base64").toString("utf8"),
  };
}

/** 仅测试用：可用但强度为零，用来验证读写流程。 */
export function createTestBackend(): SecretBackend {
  return {
    available: true,
    encrypt: (plaintext) => `test:${Buffer.from(plaintext, "utf8").toString("base64")}`,
    decrypt: (payload) => Buffer.from(payload.replace(/^test:/, ""), "base64").toString("utf8"),
  };
}

const VaultFileSchema = z.object({
  fields: z.string(),
  payload: z.string(),
});

export type Vault = Record<string, string>;

export class SecretStore {
  private cache: Vault | null = null;

  constructor(
    private readonly file: string,
    private readonly backend: SecretBackend,
  ) {}

  get encryptionAvailable(): boolean {
    return this.backend.available;
  }

  get unavailableReason(): string | null {
    return this.backend.reason ?? null;
  }

  private load(): Vault {
    if (this.cache !== null) return this.cache;
    if (!existsSync(this.file)) {
      this.cache = {};
      return this.cache;
    }
    try {
      const parsed = VaultFileSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
      if (!parsed.success) {
        this.cache = {};
        return this.cache;
      }
      const plaintext = this.backend.decrypt(parsed.data.payload);
      const value: unknown = JSON.parse(plaintext);
      this.cache = isStringRecord(value) ? value : {};
    } catch {
      // 无法解密（如跨设备或加密后端变更）时视为空配置。
      this.cache = {};
    }
    return this.cache;
  }

  list(): string[] {
    return Object.keys(this.load());
  }

  has(key: string): boolean {
    return this.load()[key] !== undefined;
  }

  get(key: string): string | null {
    return this.load()[key] ?? null;
  }

  set(key: string, value: string): Result<void, string> {
    if (!this.backend.available) {
      return err(
        `系统加密能力不可用：${this.backend.reason ?? "未知原因"}，本次未将密钥写入磁盘。请在桌面应用环境下保存凭据。`,
      );
    }
    const vault = { ...this.load(), [key]: value };
    try {
      const payload = this.backend.encrypt(JSON.stringify(vault));
      writeJsonAtomic(this.file, { fields: "payload", payload });
      this.cache = vault;
      return ok(undefined);
    } catch (error) {
      return err(`写入 secrets.bin 失败：${String(error)}，请检查存储目录权限。`);
    }
  }

  clear(key: string): Result<void, string> {
    const vault = { ...this.load() };
    delete vault[key];
    if (!this.backend.available) {
      this.cache = vault;
      return ok(undefined);
    }
    try {
      const payload = this.backend.encrypt(JSON.stringify(vault));
      writeJsonAtomic(this.file, { fields: "payload", payload });
      this.cache = vault;
      return ok(undefined);
    } catch (error) {
      return err(`写入凭据文件失败：${String(error)}，请检查磁盘写入权限。`);
    }
  }
}

function isStringRecord(value: unknown): value is Vault {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).every((item) => typeof item === "string");
}

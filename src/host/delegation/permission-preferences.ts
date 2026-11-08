import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { writeJsonAtomic } from "../boot/atomic.js";

const Schema = z.record(z.string(), z.enum(["allow", "deny"]));
export class AgentPermissionPreferences {
  constructor(private readonly file: string) {}
  private read(): Record<string, "allow" | "deny"> {
    if (!existsSync(this.file)) return {};
    return Schema.parse(JSON.parse(readFileSync(this.file, "utf8")) as unknown);
  }
  get(id: string): "allow" | "deny" { const values = this.read(); return values[id] ?? values["*"] ?? "deny"; }
  set(id: string, policy: "allow" | "deny"): void { const values = this.read(); values[id] = policy; writeJsonAtomic(this.file, values); }
}

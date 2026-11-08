import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { writeJsonAtomic } from "../boot/atomic.js";

const Schema = z.record(z.string(), z.string().min(1).max(256));

/** Native model IDs only. Provider credentials remain in their own secret stores. */
export class AgentModelPreferences {
  constructor(private readonly file: string) {}
  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    return Schema.parse(JSON.parse(readFileSync(this.file, "utf8")) as unknown);
  }
  get(id: string): string | undefined { return this.read()[id]; }
  set(id: string, value: string | null): void {
    const preferences = this.read();
    if (value === null || value.trim() === "") delete preferences[id];
    else preferences[id] = z.string().min(1).max(256).parse(value.trim());
    writeJsonAtomic(this.file, preferences);
  }
}

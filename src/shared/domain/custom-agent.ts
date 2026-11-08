import { z } from "zod";

export const CustomAgentSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(64),
  label: z.string().trim().min(1).max(100),
  protocol: z.enum(["acp", "command"]),
  binary: z.string().trim().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(100).default([]),
  enabled: z.boolean().default(true),
});
export type CustomAgent = z.infer<typeof CustomAgentSchema>;

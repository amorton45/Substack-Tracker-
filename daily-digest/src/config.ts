import { z } from "zod";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import type { AppConfig, SubstackSource } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  RESEND_API_KEY: z.string().min(1, "RESEND_API_KEY is required"),
  EMAIL_TO: z.string().email("EMAIL_TO must be a valid email"),
  EMAIL_FROM: z.string().min(1, "EMAIL_FROM is required"),
  SUBSTACK_SID: z.string().optional(),
  DIGEST_TIMEZONE: z.string().default("America/New_York"),
});

const sourcesSchema = z.object({
  substacks: z.array(
    z.object({
      name: z.string(),
      slug: z.string(),
    })
  ),
});

export function loadConfig(): AppConfig {
  const env = envSchema.parse(process.env);

  const sourcesPath = resolve(__dirname, "../config/sources.json");
  const sourcesRaw = JSON.parse(readFileSync(sourcesPath, "utf-8"));
  const sources = sourcesSchema.parse(sourcesRaw);

  const dryRun = process.argv.includes("--dry-run");

  return {
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    resendApiKey: env.RESEND_API_KEY,
    emailTo: env.EMAIL_TO,
    emailFrom: env.EMAIL_FROM,
    substackSid: env.SUBSTACK_SID || undefined,
    timezone: env.DIGEST_TIMEZONE,
    substacks: sources.substacks as SubstackSource[],
    dryRun,
  };
}

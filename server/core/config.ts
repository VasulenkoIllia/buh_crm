import { z } from "zod";

const boolFromString = z
  .string()
  .default("false")
  .transform((v) => v === "true" || v === "1");

const envSchema = z.object({
  APP_NAME: z.string().default("buh_crm"),
  APP_DOMAIN: z.string().default("localhost"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  TZ: z.string().default("Europe/Kyiv"),
  LOG_LEVEL: z.string().default("info"),

  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(16),

  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: boolFromString,
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  MAIL_FROM: z.string().default("crm@localhost"),

  UPLOADS_DIR: z.string().default("uploads"),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}

export const config = loadConfig();
export const isDev = config.NODE_ENV === "development";
export const isProd = config.NODE_ENV === "production";
export const isTest = config.NODE_ENV === "test";

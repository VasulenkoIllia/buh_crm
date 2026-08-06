import { z } from "zod";

const boolFromString = z
  .string()
  .default("false")
  .transform((v) => ["true", "1", "yes"].includes(v.trim().toLowerCase()));

/** Does the platform know this zone? `Intl` throws on an unknown name, which is the check. */
function isRealTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const envSchema = z.object({
  APP_NAME: z.string().default("buh_crm"),
  APP_DOMAIN: z.string().default("localhost"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  /**
   * The FIRM's timezone — the single answer to "what day is it" for the whole product: the
   * scheduler's sweeps, every business date, and the hours the calendar draws.
   *
   * An IANA name, not an abbreviation. "EST" is a fixed −05:00 with no daylight saving, so from
   * March to November it drifts an hour from every clock around it; "America/New_York" is the
   * thing people mean when they say EST and moves with the season on its own.
   *
   * Validated rather than trusted: a typo here would not throw, it would silently make the whole
   * app fall back to UTC and quietly shift every deadline and sweep.
   */
  TZ: z
    .string()
    .default("America/New_York")
    .refine(isRealTimezone, "Not a known IANA timezone (e.g. America/New_York, Europe/Kyiv)"),
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

  /**
   * AES-256-GCM key for client secrets, base64, 32 bytes. DELIBERATELY OPTIONAL: making it
   * required would stop an already-running server from booting the moment this code ships, before
   * anyone had a chance to add the key. Without it the Secrets tab says so and refuses to store
   * anything — a clear "not configured" beats a container that won't start.
   *   openssl rand -base64 32
   */
  SECRETS_KEY: z.string().optional(),

  // First-admin bootstrap (used on a fresh server when no users exist yet).
  BOOTSTRAP_ADMIN_EMAIL: z.string().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),
  BOOTSTRAP_ADMIN_FIRST_NAME: z.string().default("Admin"),
  BOOTSTRAP_ADMIN_LAST_NAME: z.string().default("User"),
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

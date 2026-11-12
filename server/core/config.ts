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

const envSchema = z
  .object({
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

    /**
     * **Which peers this app believes about `X-Forwarded-*`**: an address, a CIDR, a comma-separated
     * list, or a name `proxy-addr` knows.
     *
     * `trustProxy: true` trusts the whole chain, which means the LEFTMOST value wins, and that value
     * is whatever the client typed into the header. Harmless while the only reader was the rate
     * limiter; not harmless once every sign-in and every mutation stores an address that a person
     * will later be asked to account for (activity-log.md §13 A1).
     *
     * A hop count, which this was until 2026-10-31, is no better: it never looks at who connected,
     * so anybody reaching the app directly could forge all of it (GHSA-3m5p-2c4r-xxw2). Fastify
     * 5.12.1 turned the numeric form off at runtime, and with it every address the app stores.
     *
     * `uniquelocal` is the private ranges, which is where Docker puts Traefik. Cloudflare's edge is
     * public, so the walk stops there, and `core/client-ip.ts` takes it from that edge. It is an env
     * var because it is a deployment fact: a proxy on a public address has to be named here.
     *
     * Refused when empty, and when an entry is a bare number. Both would quietly believe nobody:
     * `trustProxy: ""` is falsy, and `proxy-addr` reads `2`, the old setting's value, as the address
     * 0.0.0.2. Anything else it cannot read throws when the server starts.
     */
    TRUST_PROXY: z
      .string()
      .min(1)
      .refine(
        (value) => !value.split(",").some((entry) => /^\d+$/.test(entry.trim())),
        "a hop count no longer works here: name the proxies' addresses or ranges",
      )
      .default("uniquelocal"),

    /**
     * The build this container is running, and who put it there. Both are set by
     * `scripts/deploy.sh`; both are absent in dev, where "the version" is whatever is checked out.
     * Read once at boot to record `system.started`, and to notice a deploy by the version changing.
     */
    APP_VERSION: z.string().default(""),
    DEPLOY_BY: z.string().default(""),

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
     * Where NEW files go: `local` (UPLOADS_DIR) or `s3` (the files bucket). Each File row records
     * where its own bytes are, so switching this moves nothing and strands nothing; existing files
     * move with their own script (files.md §15.0). Every file is encrypted either way (§14.4).
     *
     * The bucket's settings are read whenever they are present, not only with `s3`, so a row already
     * in the bucket stays readable if this is ever set back to `local`. The contract is
     * backups-hardening.md §7.8; the key comes from the Hetzner project `buhcrm-app`, never the
     * backup's.
     */
    FILES_STORAGE: z.enum(["local", "s3"]).default("local"),
    // empty means unset, like every other line of .env; its shape is checked with s3 (below)
    FILES_S3_ENDPOINT: z.string().optional(),
    FILES_S3_REGION: z.string().optional(),
    FILES_S3_BUCKET: z.string().optional(),
    FILES_S3_ACCESS_KEY_ID: z.string().optional(),
    FILES_S3_SECRET_ACCESS_KEY: z.string().optional(),
    FILES_S3_FORCE_PATH_STYLE: boolFromString,

    /**
     * Where the host's backup scripts leave their status — read, never written, by this app.
     * Resolved against the working directory like UPLOADS_DIR, which in the container lands on the
     * read-only mount of the host's /var/lib/buh_crm/backup-status (docker-compose.yml). Defaulted
     * rather than optional: a production watchdog that switched itself off because a variable was
     * left out would be the very silence it exists to catch. With nothing there, development stays
     * quiet and production turns red (core/backup-status.ts).
     */
    BACKUP_STATUS_DIR: z.string().default("backup-status"),

    /**
     * AES-256-GCM key for client secrets, base64, 32 bytes. DELIBERATELY OPTIONAL: making it
     * required would stop an already-running server from booting the moment this code ships, before
     * anyone had a chance to add the key. Without it the Secrets tab says so and refuses to store
     * anything — a clear "not configured" beats a container that won't start.
     *   openssl rand -base64 32
     */
    SECRETS_KEY: z.string().optional(),

    /**
     * Online payment through Stripe Checkout (payments.md §11). Both or neither: with neither the
     * feature is off and nothing about it shows. The mode, sandbox or live, is read off the key
     * (`_test_` / `_live_`) and never set apart from it, so the two cannot disagree. A restricted
     * key (`rk_`) whose one permission is Checkout Sessions: Write is the one meant for the server;
     * `sk_` is accepted for a developer's own sandbox. Empty means unset, like every other line.
     */
    STRIPE_SECRET_KEY: z
      .string()
      .optional()
      .transform((value) => value?.trim() || undefined),
    STRIPE_WEBHOOK_SECRET: z
      .string()
      .optional()
      .transform((value) => value?.trim() || undefined),

    // First-admin bootstrap (used on a fresh server when no users exist yet).
    BOOTSTRAP_ADMIN_EMAIL: z.string().optional(),
    BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),
    BOOTSTRAP_ADMIN_FIRST_NAME: z.string().default("Admin"),
    BOOTSTRAP_ADMIN_LAST_NAME: z.string().default("User"),
  })
  /**
   * The bucket needs all of its settings, and SECRETS_KEY with them: every file is encrypted with
   * it (files.md §14.4), so a bucket without the key would refuse every upload. Refused at boot
   * rather than at the first upload, because FILES_STORAGE=s3 is only ever set on purpose.
   */
  /**
   * Production keeps its files in the bucket, and has mounted no uploads directory since
   * 2026-10-03 (files.md §15.0 step 7). On `local` a new file would be written inside the
   * container and go with the next deploy, so the server refuses to start rather than lose one.
   * Development and the tests are untouched.
   */
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && env.FILES_STORAGE === "local") {
      ctx.addIssue({
        code: "custom",
        path: ["FILES_STORAGE"],
        message:
          "must be s3 in production: nothing mounts a local store, so a new file would be lost " +
          "on the next deploy",
      });
    }
  })
  .superRefine((env, ctx) => {
    if (env.FILES_STORAGE !== "s3") return;
    const needed = [
      "FILES_S3_ENDPOINT",
      "FILES_S3_REGION",
      "FILES_S3_BUCKET",
      "FILES_S3_ACCESS_KEY_ID",
      "FILES_S3_SECRET_ACCESS_KEY",
      "SECRETS_KEY",
    ] as const;
    for (const name of needed) {
      if (!env[name]) {
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: "required when FILES_STORAGE=s3",
        });
      }
    }
    if (env.FILES_S3_ENDPOINT && !URL.canParse(env.FILES_S3_ENDPOINT)) {
      ctx.addIssue({
        code: "custom",
        path: ["FILES_S3_ENDPOINT"],
        message: "must be a URL, e.g. https://fsn1.your-objectstorage.com",
      });
    }
  })
  /**
   * A key without its webhook secret would take money the CRM never hears about, and a secret
   * without a key is a half-finished setup. Refused at boot, like the bucket above, because both
   * are only ever set on purpose. The shapes are checked so the two values cannot be swapped and a
   * publishable key (`pk_`) cannot stand in for a secret one.
   */
  .superRefine((env, ctx) => {
    const key = env.STRIPE_SECRET_KEY;
    const secret = env.STRIPE_WEBHOOK_SECRET;
    if (!key && !secret) return;
    if (!key || !secret) {
      ctx.addIssue({
        code: "custom",
        path: [key ? "STRIPE_WEBHOOK_SECRET" : "STRIPE_SECRET_KEY"],
        message: "STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set together or not at all",
      });
      return;
    }
    if (!STRIPE_KEY_SHAPE.test(key)) {
      ctx.addIssue({
        code: "custom",
        path: ["STRIPE_SECRET_KEY"],
        message:
          "must be a secret or restricted key: rk_test_…, rk_live_…, sk_test_… or sk_live_…",
      });
    }
    if (!secret.startsWith("whsec_")) {
      ctx.addIssue({
        code: "custom",
        path: ["STRIPE_WEBHOOK_SECRET"],
        message: "must be the endpoint's signing secret, whsec_…",
      });
    }
  });

/** `rk_`/`sk_`, the mode, and the rest of the key. The mode is what `modeOfKey()` reads. */
export const STRIPE_KEY_SHAPE = /^(rk|sk)_(test|live)_[A-Za-z0-9]+$/;

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

/**
 * Backup credentials that reached the app's own environment (backups-hardening.md §7.8).
 * `env_file: .env` hands the whole file to the container, and the AWS SDK behind the files bucket
 * reads some of these names on its own, so a restic or rclone key pasted into `.env` would reach
 * code that must never hold one. `server.ts` logs them at boot.
 */
export function strayBackupVariables(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env)
    .filter((name) => /^(AWS_|RESTIC_|RCLONE_|B2_)/.test(name))
    .sort();
}

export const config = loadConfig();
export const isDev = config.NODE_ENV === "development";
export const isProd = config.NODE_ENV === "production";
export const isTest = config.NODE_ENV === "test";

import argon2 from "argon2";
import { NOTIFICATION_TRIGGERS } from "@shared/notifications.js";
import { prisma } from "./db.js";
import { config } from "./config.js";

// Startup bootstrap — makes a fresh (production) database usable out of the box:
//   1. ensureBaseData()      — settings defaults every install needs (idempotent, non-destructive).
//   2. ensureBootstrapAdmin() — the FIRST admin, created only when no users exist yet.
// Both run on server boot (see server.ts). Safe to run on every start.

const PRIORITIES = [
  { name: "Low", color: "#6b7280", order: 0, isDefault: false },
  { name: "Normal", color: "#2f4fd6", order: 1, isDefault: true },
  { name: "High", color: "#b5651d", order: 2, isDefault: false },
  { name: "Urgent", color: "#c23434", order: 3, isDefault: false },
];

const SOURCES = ["Referral", "Website", "Social", "Cold", "Event", "Other"];

/**
 * The pipeline the firm starts with. A TABLE since 2026-08-28 — the migration seeds these same six
 * for an existing database, and this is what puts them back after a `--reset`, which clears base
 * data on purpose. Upserted by name, so a stage the firm has since renamed or reordered is never
 * resurrected or overwritten.
 */
const LEAD_STAGES = [
  "First contact",
  "No answer",
  "Set up meeting",
  "Thinking",
  "On hold",
  "Next time",
];

/**
 * Ensures the defaults the app can't work without exist: task priorities, source
 * options, the leads pipeline's stages, the fixed "New" task column, and the firm profile
 * singleton.
 * Non-destructive: existing rows are left untouched (admin edits are preserved).
 */
export async function ensureBaseData() {
  for (const p of PRIORITIES) {
    await prisma.priority.upsert({ where: { name: p.name }, update: {}, create: p });
  }

  for (const [order, name] of SOURCES.entries()) {
    await prisma.sourceOption.upsert({ where: { name }, update: {}, create: { name, order } });
  }

  for (const [order, name] of LEAD_STAGES.entries()) {
    await prisma.leadStage.upsert({ where: { name }, update: {}, create: { name, order } });
  }

  const fixedColumn = await prisma.taskColumn.findFirst({ where: { isFixed: true } });
  if (!fixedColumn) {
    await prisma.taskColumn.create({ data: { name: "New", order: 0, isFixed: true } });
  }

  await prisma.firmProfile.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, name: config.APP_NAME },
  });

  await ensureNotificationPolicies();

  await ensureDefaultMailbox();
}

/**
 * One policy row per trigger in the registry.
 *
 * Seeded exactly as Priority and SourceOption are, and for the same reason: the app cannot work
 * without them, and the emitter reads the row BEFORE it does anything else — a trigger with no row
 * notifies nobody. Adding a trigger is therefore a constant in shared/notifications.ts plus this
 * boot, with no migration.
 *
 * What the firm owns and what the registry owns are DIFFERENT FIELDS, and the split is the whole
 * design:
 *
 *   • `enabled`, `inApp`, `email`, `defaultInApp`, `defaultEmail` — the firm's. Seeded once and
 *     never touched again, because §9's rollout is "ship all sixteen on, then silence what proves
 *     noisy from the Settings screen" and the next deploy must not undo that.
 *   • `roles` — the REGISTRY's, and re-seeded on every boot. There is no UI for it (§6.3), so the
 *     constant is the only thing that can be said to define it. Leaving it alone was a silent
 *     failure, found in testing on 2026-09-05: `ops_mailout_errors` was seeded `["custom"]`, the
 *     registry was later corrected to `["author", "custom"]` — and on any database seeded before
 *     that correction the trigger stayed enabled, showed "Goes to: custom" on the Settings screen,
 *     and notified NOBODY, because `customUserIds` is empty. A trigger that is on and reaches no
 *     one is the worst of both states, and nothing surfaces it.
 *   • `customUserIds` — the firm's, always. "Which bookkeeper hears about overdue invoices" is
 *     their answer, never the constant's, and re-seeding it would erase it.
 *   • `mandatory` — left alone deliberately. It is seeded false everywhere and reserved for the
 *     security package; a hand-set `true` is somebody forcing a critical alert through, and a
 *     deploy quietly undoing that is worse than the drift. A registry change to it therefore does
 *     NOT reach an existing database — say so in the change log if that day comes.
 *
 * `notifications.integration.test.ts` holds `roles` to the registry, so the two cannot drift again.
 */
async function ensureNotificationPolicies() {
  for (const [trigger, spec] of Object.entries(NOTIFICATION_TRIGGERS)) {
    await prisma.notificationPolicy.upsert({
      where: { trigger },
      update: { roles: spec.defaultRecipients },
      create: {
        trigger,
        enabled: true,
        mandatory: spec.mandatory,
        roles: spec.defaultRecipients,
        customUserIds: [],
        // both channels are ALLOWED for every trigger — what differs is which one is on by
        // default. Disallowing a channel is an admin decision, not a shipped one.
        inApp: true,
        email: true,
        sound: true,
        defaultInApp: spec.defaultInApp,
        defaultEmail: spec.defaultEmail,
        defaultSound: spec.defaultSound,
      },
    });
  }
}

/**
 * The firm always has somewhere to send from.
 *
 * Seeded from the `.env` account — the one that already delivers invites and password resets — so
 * a fresh install can send a letter before anyone configures anything. Without this the Mailouts
 * module is inert on day one and the first thing a new firm meets is "No sender mailbox is set up".
 *
 * `smtpHost` is deliberately left NULL: that is what "borrow the `.env` account" means, and it
 * keeps the mailbox correct when the environment's SMTP details later change. Copying host, port
 * and password in here would freeze a snapshot of `.env` that silently goes stale.
 *
 * Created ONCE, and never updated: from then on it is the firm's row to rename, re-point or
 * deactivate. A bootstrap that rewrote it on every restart would undo their edits every deploy.
 */
async function ensureDefaultMailbox() {
  if ((await prisma.mailSenderAccount.count()) > 0) return;

  const firm = await prisma.firmProfile.findUnique({ where: { id: 1 } });
  await prisma.mailSenderAccount.create({
    data: {
      name: "Server mailbox",
      fromName: firm?.name ?? config.APP_NAME,
      // the address the server is actually entitled to send as — most SMTP servers refuse any
      // other, so this is the one From that is guaranteed to work untouched
      fromEmail: config.MAIL_FROM,
      contactEmail: config.MAIL_FROM,
      isDefault: true,
      isInvoiceSender: true,
    },
  });
}

interface BootstrapLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface BootstrapAdminOptions {
  email?: string;
  password?: string;
  firstName?: string;
  lastName?: string;
}

/**
 * Creates the first admin from env, but ONLY when the users table is empty.
 * Idempotent and safe: once any user exists it never touches accounts again,
 * so it can't overwrite a real admin or reset a password on restart.
 */
export async function ensureBootstrapAdmin(
  log: BootstrapLogger,
  opts: BootstrapAdminOptions = {
    email: config.BOOTSTRAP_ADMIN_EMAIL,
    password: config.BOOTSTRAP_ADMIN_PASSWORD,
    firstName: config.BOOTSTRAP_ADMIN_FIRST_NAME,
    lastName: config.BOOTSTRAP_ADMIN_LAST_NAME,
  },
): Promise<{ created: boolean }> {
  const existingUsers = await prisma.user.count();
  if (existingUsers > 0) {
    return { created: false }; // already provisioned — leave accounts alone
  }

  const email = opts.email?.trim().toLowerCase(); // identity emails are matched lowercased
  const password = opts.password;
  if (!email || !password) {
    log.warn(
      "No users exist yet and BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD are not set — " +
        "no admin was created. Set them in the environment and restart to create the first admin.",
    );
    return { created: false };
  }
  if (password.length < 8) {
    log.error(
      "BOOTSTRAP_ADMIN_PASSWORD must be at least 8 characters — first admin NOT created.",
    );
    return { created: false };
  }

  try {
    await prisma.user.create({
      data: {
        firstName: opts.firstName || "Admin",
        lastName: opts.lastName || "User",
        email,
        passwordHash: await argon2.hash(password),
        role: "admin",
        status: "active",
        emailConfirmedAt: new Date(),
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      // two instances raced the empty-DB check — the other one won; nothing to do
      log.info({ email }, "Bootstrap admin already exists — skipping.");
      return { created: false };
    }
    throw err;
  }
  log.info({ email }, "Bootstrap admin created — sign in and change the password.");
  return { created: true };
}

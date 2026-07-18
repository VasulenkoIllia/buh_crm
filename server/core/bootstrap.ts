import argon2 from "argon2";
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
 * Ensures the defaults the app can't work without exist: task priorities, source
 * options, the fixed "New" task column, and the firm profile singleton.
 * Non-destructive: existing rows are left untouched (admin edits are preserved).
 */
export async function ensureBaseData() {
  for (const p of PRIORITIES) {
    await prisma.priority.upsert({ where: { name: p.name }, update: {}, create: p });
  }

  for (const [order, name] of SOURCES.entries()) {
    await prisma.sourceOption.upsert({ where: { name }, update: {}, create: { name, order } });
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

  const email = opts.email?.trim();
  const password = opts.password;
  if (!email || !password) {
    log.warn(
      "No users exist yet and BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD are not set — " +
        "no admin was created. Set them in the environment and restart to create the first admin.",
    );
    return { created: false };
  }
  if (password.length < 8) {
    log.error("BOOTSTRAP_ADMIN_PASSWORD must be at least 8 characters — first admin NOT created.");
    return { created: false };
  }

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
  log.info({ email }, "Bootstrap admin created — sign in and change the password.");
  return { created: true };
}

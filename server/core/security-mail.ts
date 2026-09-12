/**
 * **The letters about an account's own security** (two-factor.md §9, §12).
 *
 * Sent through `sendEmail` — the invite channel — and never the notifications pipeline: a person
 * cannot opt out of being told their own account is under attack, and a security alert a
 * preference can silence is not a security alert. The letters that are about an attack or about an
 * admin's act also go to every other admin (decision 11), so no single account can make them
 * silent.
 *
 * In core because both `auth` (a run of wrong passwords) and `two-factor` (a run of wrong codes,
 * the changes to a second factor) write them. Fire-and-forget throughout: the request each one
 * accompanies has already been answered, or must not wait for SMTP.
 */
import { fmtDayInTz, fmtDayTimeInTz, fmtTimeInTz } from "@shared/dates.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { sendEmail, webOrigin, type EmailTemplates } from "./email.js";
import { personName } from "./names.js";
import { claimAlert, FREE_FAILURES, type ThrottleState } from "./sign-in-throttle.js";
import { describeBrowser } from "./user-agent.js";

/** Where an attempt came from — for the counters and the letters, never for a decision. */
export interface AttemptOrigin {
  ip: string;
  userAgent: string | null;
}

interface Person {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

type TwoFactorChange = EmailTemplates["twoFactorChanged"]["change"];

/** The failure that earns a letter: the first one that makes the next attempt wait. */
const ALERT_AFTER_FAILURES = FREE_FAILURES + 1;
/** "One bad afternoon is one letter and not forty" (§9). */
const ALERT_DEDUPE_MS = 12 * 60 * 60 * 1000;

function send<T extends keyof EmailTemplates>(
  template: T,
  to: string,
  data: EmailTemplates[T],
): void {
  void sendEmail(template, to, data).catch(() => {
    /* logged by the mailer; the act this letter reports has already happened */
  });
}

function otherAdmins(excluding: string[]) {
  return prisma.user.findMany({
    where: { role: "admin", status: "active", id: { notIn: excluding } },
    select: { email: true },
  });
}

/** "Sat 12 Sept, 08:47 – 08:52" — or one time, when the whole run fell inside a minute. */
function runWindow(run: ThrottleState): string {
  const first = fmtDayTimeInTz(run.firstFailureAt, config.TZ);
  const sameDay =
    fmtDayInTz(run.firstFailureAt, config.TZ) === fmtDayInTz(run.lastFailureAt, config.TZ);
  const last = sameDay
    ? fmtTimeInTz(run.lastFailureAt, config.TZ)
    : fmtDayTimeInTz(run.lastFailureAt, config.TZ);
  return first.endsWith(last) ? first : `${first} – ${last}`;
}

/**
 * **The letter a run of failures earns** — one per account per twelve hours, claimed by a
 * conditional update so two failures landing together cannot both send it. `kind` says which
 * door: a run of wrong PASSWORDS, or a run of wrong CODES after a right password — which means
 * somebody has the password and not the phone, the most useful sentence this module can write.
 */
export async function alertOnRun(
  user: Person,
  run: ThrottleState,
  origin: AttemptOrigin,
  kind: "password" | "code",
): Promise<void> {
  if (run.failures < ALERT_AFTER_FAILURES) return;
  if (!(await claimAlert(run.key, ALERT_DEDUPE_MS))) return;
  const facts = {
    kind,
    attempts: run.failures,
    when: runWindow(run),
    ip: origin.ip,
    browser: describeBrowser(origin.userAgent),
  };
  send("signInAlert", user.email, {
    ...facts,
    account: null,
    url: `${webOrigin()}/profile?tab=password`,
  });
  const account = { name: personName(user), email: user.email };
  for (const admin of await otherAdmins([user.id])) {
    send("signInAlert", admin.email, {
      ...facts,
      account,
      url: `${webOrigin()}/settings?tab=activity`,
    });
  }
}

/**
 * **What happened to a person's second factor, told to them** (§12). If they did not do it, this
 * letter is the only thing that will tell them.
 */
export function tellOwner(
  user: Person,
  change: TwoFactorChange,
  extra: { by?: string; codesLeft?: number } = {},
): void {
  send("twoFactorChanged", user.email, {
    change,
    by: extra.by ?? null,
    account: null,
    codesLeft: extra.codesLeft ?? null,
    url: `${webOrigin()}/profile?tab=security`,
  });
}

/**
 * **An admin's reset, told to the OTHER admins too** (decision 11). A compromised admin can strip
 * anybody's second factor; this is what stops them doing it quietly.
 */
export async function tellAdminsOfReset(target: Person, actor: Person): Promise<void> {
  const account = { name: personName(target), email: target.email };
  for (const admin of await otherAdmins([target.id, actor.id])) {
    send("twoFactorChanged", admin.email, {
      change: "reset",
      by: personName(actor),
      account,
      codesLeft: null,
      url: `${webOrigin()}/team`,
    });
  }
}

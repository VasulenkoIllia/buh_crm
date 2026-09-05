/**
 * Raising a NOTIFICATION, in one place.
 *
 * Tasks, Calendar, Payments and Mailouts all need to do it, and the module graph is a DAG — none
 * of them may import another (eslint.config.js enforces it, so there is no other option that
 * compiles). This is the identical problem `server/core/system-tasks.ts` already solved, and its
 * reasoning applies unchanged: rather than four near-identical copies of "resolve recipients,
 * check preferences, insert, swallow the duplicate", the shared shape lives here and each module
 * passes its own context.
 *
 * Two rules that are easy to lose and expensive to lose:
 *
 *   1. `notify()` is called AFTER the caller's transaction commits, never inside it. A
 *      notification for a write that then rolls back is not recoverable — the row is already in
 *      somebody's tray and the mail has already gone.
 *   2. It never throws. A failed notification must not fail the request that caused it, so
 *      everything in here is logged and swallowed. The return value is rows written; 0 is normal.
 */
import {
  NOTIFICATION_TRIGGERS,
  notificationPath,
  renderNotificationText,
  type NotificationChannel,
  type NotificationTriggerKey,
  type RecipientRole,
} from "@shared/notifications.js";
import { prisma } from "./db.js";
import { sendEmail, webOrigin } from "./email.js";

export interface NotifyContext {
  /**
   * The identity of the THING, never the day. `task_overdue:{taskId}` notifies once, ever;
   * `task_deadline_near:{taskId}` likewise. For event triggers the natural id is already unique
   * (`task_comment:{commentId}`). The emitter prefixes the trigger — no call site composes a key.
   */
  dedup: string;
  /** who did it. Removed from the recipient set — nobody is told about their own action. */
  actorId?: string | null;
  /** `{name}` variables for the trigger's title template */
  vars?: Record<string, string | undefined>;
  /** the tray row's second, quieter line */
  sub?: string | null;
  /** where `Open` goes. `linkType` is free text, so "thread" will work with no schema change. */
  link?: { type: string; id: string } | null;

  // ── role inputs: what the roles on the policy row are resolved against ──────
  /** resolves `assignee`, `author` and `participant` */
  taskId?: string;
  /** `author` for a record that is not a task — a mailout run, and threads later */
  authorId?: string | null;
  /** resolves `participant` for a meeting */
  meetingId?: string;
  /** the person a `self` trigger is about — the one role that may be the actor */
  selfUserId?: string;
}

interface Recipient {
  userId: string;
  reason: RecipientRole;
}

/**
 * `participant`, DERIVED — one named function, one query.
 *
 * Today a task's participants are whoever has written in its comments. When comments become chat
 * threads, this is the single place that changes. Had participation been a watchers TABLE, the
 * comment migration would have had to migrate watcher rows too, which is why §3.5 of the spec
 * reserves the role without storing it.
 */
async function resolveParticipants(taskId: string): Promise<string[]> {
  const rows = await prisma.taskComment.findMany({
    where: { taskId },
    select: { authorId: true },
    distinct: ["authorId"],
  });
  return rows.map((r) => r.authorId).filter((id): id is string => id !== null);
}

async function resolveRole(role: RecipientRole, ctx: NotifyContext): Promise<string[]> {
  switch (role) {
    case "assignee":
      if (!ctx.taskId) return [];
      return (
        await prisma.taskAssignee.findMany({
          where: { taskId: ctx.taskId },
          select: { userId: true },
        })
      ).map((a) => a.userId);

    case "author": {
      // an explicit author wins: not every record with an author is a task
      if (ctx.authorId) return [ctx.authorId];
      if (!ctx.taskId) return [];
      const task = await prisma.task.findUnique({
        where: { id: ctx.taskId },
        select: { createdById: true },
      });
      // null for every GENERATED task ("generated tasks stay null"). Not an error: the trigger
      // simply has no recipient and nothing is written.
      return task?.createdById ? [task.createdById] : [];
    }

    case "participant": {
      if (ctx.meetingId) {
        return (
          await prisma.meetingParticipant.findMany({
            where: { meetingId: ctx.meetingId },
            select: { userId: true },
          })
        ).map((p) => p.userId);
      }
      return ctx.taskId ? resolveParticipants(ctx.taskId) : [];
    }

    case "mentioned":
      return []; // reserved: @-mentions arrive with chat. No parser, no UI, no trigger uses it yet.

    case "admin":
      return (
        await prisma.user.findMany({
          where: { role: "admin", status: "active" },
          select: { id: true },
        })
      ).map((u) => u.id);

    case "custom":
      return []; // filled from the policy row by the caller below — it has the row, this does not.

    case "self":
      return ctx.selfUserId ? [ctx.selfUserId] : [];

    case "client_owner":
      // Reachable only if somebody edits a policy row by hand: nothing seeds it. Skipped with a
      // warning rather than thrown — "who is responsible for this client" does not exist until the
      // roles package, and an unknown role must not take a notification down with it.
      console.warn("[notify] recipient role `client_owner` is not implemented — skipped");
      return [];
  }
}

/**
 * Expand the policy's roles into people, in the REGISTRY's declared order.
 *
 * The order is what makes `reason` meaningful: somebody who is both an assignee and a participant
 * is notified as an assignee, so "tell me where I am assigned but not where I merely commented" is
 * expressible. Roles an admin has added by hand that the registry does not declare are appended
 * afterwards rather than dropped.
 */
async function resolveRecipients(
  trigger: NotificationTriggerKey,
  policyRoles: RecipientRole[],
  customUserIds: string[],
  ctx: NotifyContext,
): Promise<Recipient[]> {
  const declared = NOTIFICATION_TRIGGERS[trigger].defaultRecipients;
  const ordered = [
    ...declared.filter((r) => policyRoles.includes(r)),
    ...policyRoles.filter((r) => !declared.includes(r)),
  ];

  const seen = new Map<string, RecipientRole>();
  for (const role of ordered) {
    const ids = role === "custom" ? customUserIds : await resolveRole(role, ctx);
    for (const id of ids) {
      if (!seen.has(id)) seen.set(id, role); // FIRST role wins — see the doc comment
    }
  }

  /**
   * The actor never hears about their own action. There is no setting for it: every tool behaves
   * this way, and making it configurable would only let somebody manufacture guaranteed noise for
   * themselves.
   *
   * `self` is the one exception, and it is not really one: `timer_left_running` is a consequence
   * of INACTION, addressed to the person it is about by design.
   */
  if (ctx.actorId) {
    const asSelf = seen.get(ctx.actorId) === "self";
    if (!asSelf) seen.delete(ctx.actorId);
  }
  if (seen.size === 0) return [];

  // a blocked user receives nothing: they cannot open the link, and the mail would reach somebody
  // the firm has just cut off
  const active = await prisma.user.findMany({
    where: { id: { in: [...seen.keys()] }, status: "active" },
    select: { id: true, email: true },
  });
  return active.map((u) => ({ userId: u.id, reason: seen.get(u.id)! }));
}

interface ChannelChoice {
  inApp: boolean;
  email: boolean;
  /** the browser's job, decided here so it is decided once and by the same rules */
  sound: boolean;
}

/**
 * Precedence, evaluated per user per channel, in this order:
 *
 *   1. policy disabled            → nobody, whatever anyone set   (handled by the caller)
 *   2. channel not allowed        → that channel only, off
 *   3. policy.mandatory           → send; a personal off is ignored
 *   4. reason === "mentioned"     → send; a personal off is ignored  (reserved with the role)
 *   5. a preference row exists    → it decides
 *   6. otherwise                  → the policy default
 *
 * Rule 4 is the one people expect without being able to name it: somebody who has muted a
 * discussion must still hear it when they are addressed by name. GitHub, Slack and Linear all
 * behave this way, and retrofitting it after people have tuned their preferences would change
 * behaviour under them — which is why it is here before any parser exists.
 */
function decide(
  policy: {
    mandatory: boolean;
    inApp: boolean;
    email: boolean;
    sound: boolean;
    defaultInApp: boolean;
    defaultEmail: boolean;
    defaultSound: boolean;
  },
  reason: RecipientRole,
  prefs: Map<string, boolean>,
  trigger: string,
): ChannelChoice {
  const forced = policy.mandatory || reason === "mentioned";
  const pick = (channel: NotificationChannel, allowed: boolean, byDefault: boolean) => {
    if (!allowed) return false;
    if (forced) return true;
    const own = prefs.get(`${trigger}:${channel}`);
    return own ?? byDefault;
  };
  const inApp = pick("in_app", policy.inApp, policy.defaultInApp);
  return {
    inApp,
    email: pick("email", policy.email, policy.defaultEmail),
    /**
     * A chime with nothing to look at is a noise with no explanation, so the sound rides on the
     * tray row: it can only happen where the bell already does. That also means muting the bell
     * for a trigger silences its chime, which is what anybody would expect without being told.
     */
    sound: inApp && pick("sound", policy.sound, policy.defaultSound),
  };
}

/**
 * Raise a notification. Returns the number of rows written; 0 is normal and never an error.
 */
export async function notify(
  trigger: NotificationTriggerKey,
  ctx: NotifyContext,
): Promise<number> {
  try {
    return await run(trigger, ctx);
  } catch (err) {
    // never propagate: the write that caused this has already committed, and failing the request
    // afterwards would report a failure that did not happen
    console.error(`[notify] ${trigger} failed:`, err);
    return 0;
  }
}

async function run(trigger: NotificationTriggerKey, ctx: NotifyContext): Promise<number> {
  const spec = NOTIFICATION_TRIGGERS[trigger];
  if (!ctx.dedup) {
    // loud in development, because a silent empty key is the one failure mode that mails the whole
    // firm on every restart: NULLs are distinct to Postgres, and so are re-composed empty keys
    throw new Error(`notify(${trigger}) called with an empty ctx.dedup`);
  }

  const policy = await prisma.notificationPolicy.findUnique({ where: { trigger } });
  // an unseeded trigger is not an error either — `ensureBaseData` creates the row on the next boot
  if (!policy || !policy.enabled) return 0;

  const recipients = await resolveRecipients(
    trigger,
    policy.roles as RecipientRole[],
    policy.customUserIds,
    ctx,
  );
  if (recipients.length === 0) return 0;

  const prefRows = await prisma.notificationPreference.findMany({
    where: { userId: { in: recipients.map((r) => r.userId) }, trigger },
  });
  const prefsByUser = new Map<string, Map<string, boolean>>();
  for (const row of prefRows) {
    const own = prefsByUser.get(row.userId) ?? new Map<string, boolean>();
    own.set(`${row.trigger}:${row.channel}`, row.enabled);
    prefsByUser.set(row.userId, own);
  }

  const dedupKey = `${trigger}:${ctx.dedup}`;
  const text = renderNotificationText(spec.title, ctx.vars ?? {});

  /**
   * Who already has this one — asked BEFORE inserting, not discovered by failing to.
   *
   * The unique constraint below is still the real guard, and the `P2002` catch still stands for
   * the race two processes can lose to each other. But a duplicate is not an exceptional case
   * here, it is the NORMAL one: `catchUp` re-runs every sweep on every boot, so on a firm with
   * forty overdue tasks the nightly run would raise forty constraint violations — and
   * `core/db.ts` logs Prisma at `error` level in production. A log that reports forty errors on
   * every deploy for working correctly is a log nobody reads.
   *
   * One indexed lookup on `@@unique([userId, dedupKey])` buys that back.
   */
  const already = new Set(
    (
      await prisma.notification.findMany({
        where: { dedupKey, userId: { in: recipients.map((r) => r.userId) } },
        select: { userId: true },
      })
    ).map((r) => r.userId),
  );

  let written = 0;

  for (const { userId, reason } of recipients) {
    if (already.has(userId)) continue; // already raised — the normal outcome of a re-run
    const choice = decide(policy, reason, prefsByUser.get(userId) ?? new Map(), trigger);
    if (!choice.inApp && !choice.email) continue;

    /**
     * The row is written whenever EITHER channel is wanted, and stamped read on the spot when the
     * tray is not.
     *
     * That looks odd until you see what the row is for: `@@unique(userId, dedupKey)` is the send
     * throttle as much as the tray's, so a sweep re-run by `catchUp` on every boot mails nobody
     * twice. Somebody who wants mail but not the bell still needs that guarantee — and a row they
     * never asked to see must not sit in their tray to provide it.
     */
    try {
      const row = await prisma.notification.create({
        data: {
          userId,
          trigger,
          reason,
          text,
          sub: ctx.sub ?? null,
          linkType: ctx.link?.type ?? null,
          linkId: ctx.link?.id ?? null,
          dedupKey,
          sound: choice.sound,
          readAt: choice.inApp ? null : new Date(),
        },
      });
      written++;

      // Mail goes only AFTER the insert succeeded. That is the whole reason `dedupKey` is NOT
      // NULL: a duplicate insert throws below and the send never happens.
      if (choice.email) await mail(row.id, userId, text, ctx);
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") continue; // already raised — skipped, never an error
      throw err;
    }
  }
  return written;
}

/**
 * Fire-and-forget per message, exactly as invitations and password resets are
 * (`void sendEmail(...)` — users.service.ts:45, auth.service.ts:66).
 *
 * The `void` is the whole point, and it was NOT here at first. `notify()` is awaited inside
 * `createTask`, so an awaited `sendEmail` puts an SMTP round trip in the user's own request — and
 * `sendEmail` retries three times against a 10-second connection timeout. Measured 2026-09-05
 * against a host that DROPS packets rather than refusing them: creating one task took **33
 * seconds**, and would take about a hundred with three assignees, because recipients are mailed
 * in turn. The browser simply hangs. That is the failure §5.5 of the spec forbids — "a failed
 * notification must not fail the request that caused it" — reached by being slow instead of by
 * throwing, which is the version nobody writes a test for.
 *
 * The address itself IS still awaited: one indexed local lookup, and resolving it inside the
 * detached promise would only make a failure harder to see. In `NODE_ENV=test` `sendEmail` writes
 * to `testOutbox` synchronously before its first await, so outbox assertions stay reliable;
 * `emailedAt` lands later, so a test that asserts THAT has to poll for it.
 *
 * An SMTP failure is logged and leaves `emailedAt` null. It is never retried beyond `sendEmail`'s
 * own three attempts: the notification is already in the tray, which is the channel of record.
 */
async function mail(
  notificationId: string,
  userId: string,
  text: string,
  ctx: NotifyContext,
): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) return;
    void sendEmail("notification", user.email, {
      title: text,
      sub: ctx.sub ?? null,
      // the SAME resolver the tray's Open uses (shared/notifications.ts) — one definition, so a
      // letter's button and a tray row can never point at different screens
      url: (() => {
        const path = notificationPath(ctx.link?.type ?? null, ctx.link?.id ?? null);
        return path ? `${webOrigin()}${path}` : null;
      })(),
    })
      .then(() =>
        prisma.notification.update({
          where: { id: notificationId },
          data: { emailedAt: new Date() },
        }),
      )
      .catch((err) => console.error("[notify] email failed:", err));
  } catch (err) {
    console.error("[notify] could not resolve a recipient's address:", err);
  }
}

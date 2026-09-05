/**
 * Every notification the firm can raise — the trigger registry.
 *
 * This is the SOURCE, not a copy. The emitter reads its text template from here, the policy screen
 * and the profile screen render from here, and `ensureBaseData` seeds one policy row per key. A
 * trigger therefore cannot exist in the UI and not in the code, or the reverse, and adding one
 * later is a constant plus a seeded row — no migration.
 *
 * Modelled on `shared/system-tasks.ts`, and zero-dependency for the same reason: importing a VALUE
 * out of a schema module pulls the whole zod runtime into the browser bundle — measured at
 * +433 kB — and this one is read by the UI.
 */

export type NotificationGroup =
  "tasks" | "discussion" | "meetings" | "billing" | "ops" | "personal";

/**
 * How the emitter finds the people to notify.
 *
 * `participant` and `mentioned` are DERIVED, never stored. When task comments become chat threads
 * one query changes in one function; had this been a watchers table, the comment migration would
 * have had to migrate watcher rows too.
 */
export type RecipientRole =
  | "assignee" // the task's assignees (TaskAssignee)
  | "author" // who created the record (Task.createdById — null for generated tasks)
  | "participant" // DERIVED: whoever has already written in the thread
  | "mentioned" // DERIVED: named with @ in the body — reserved, no parser exists yet
  | "admin" // every active admin
  | "custom" // the explicit user list on the policy row
  | "self" // the person the fact is ABOUT — the one role that may be the actor
  | "client_owner"; // reserved — no such concept until the roles package. Never seeded.

/**
 * `sound` is a channel, not a switch of its own.
 *
 * It obeys the same two rules the other two do — the firm decides whether it is allowed at all,
 * each person decides whether they want it — so modelling it any other way would have meant a
 * second, parallel pair of settings screens for one boolean. It is the only channel the SERVER
 * does not deliver: the decision is made and stored here, and the browser plays it (S9.1).
 */
export type NotificationChannel = "in_app" | "email" | "sound";

export type NotificationTriggerKey =
  | "task_assigned"
  | "task_comment"
  | "task_deadline_changed"
  | "task_deadline_near"
  | "task_overdue"
  | "task_done"
  | "task_reopened"
  | "task_cancelled"
  | "meeting_invited"
  | "meeting_today"
  | "meeting_moved"
  | "meeting_cancelled"
  | "meeting_restored"
  | "meeting_uninvited"
  | "meeting_soon"
  | "invoice_overdue"
  | "ops_mailbox_broken"
  | "ops_sweep_failed"
  | "ops_mailout_errors"
  | "timer_left_running";

export interface NotificationTriggerSpec {
  group: NotificationGroup;
  /** the row's first line in the tray, rendered from ctx — `{name}` placeholders */
  title: string;
  /** in plain words, when it fires — shown in the policy screen */
  when: string;
  /** why it exists, i.e. the miss it prevents */
  why: string;
  source: "event" | "sweep";
  /** ORDER MATTERS: a person matched by two roles is notified as the first one listed */
  defaultRecipients: RecipientRole[];
  defaultInApp: boolean;
  defaultEmail: boolean;
  /** a chime when it arrives, for the person who is at their desk right now */
  defaultSound: boolean;
  /** a personal off cannot override it. Seeded false for all 16; reserved for the security package */
  mandatory: boolean;
}

/**
 * The settings buckets, in the order both screens render them.
 */
export const NOTIFICATION_GROUPS: Record<NotificationGroup, { label: string; order: number }> =
  {
    tasks: { label: "Tasks", order: 0 },
    discussion: { label: "Discussion", order: 1 },
    meetings: { label: "Meetings", order: 2 },
    billing: { label: "Billing", order: 3 },
    ops: { label: "Operations", order: 4 },
    personal: { label: "Personal", order: 5 },
  };

/**
 * Sixteen triggers, trimmed from 32 candidates by one rule:
 *
 *   > A lifecycle event of a record → yes. A step of ordinary work → no.
 *
 * A lifecycle event fires once per record and changes what somebody does next. A work step fires
 * dozens of times a day and IS the work — a card moved between columns, a subtask ticked, a
 * priority changed. Those are excluded on purpose (docs/modules/notifications.md §3.4).
 *
 * `defaultSound` is the most conservative of the three, and deliberately so: a chime is the only
 * channel that interrupts somebody who is not looking. It is on for the four triggers where a
 * PERSON just did something that concerns you — an assignment, a comment, an invitation, a moved
 * meeting — and off for every sweep, because those all land at 07:00 together and a chime each
 * would be a burst of noise on the hour. (The browser coalesces a poll to one sound anyway, but
 * defaulting them on would still be wrong.)
 *
 * `defaultEmail` is the one judgement call that is not simply "on": the bell is the channel of
 * record, and mail exists for the things you would miss while NOT looking at the CRM. So the
 * lifecycle facts that start or move somebody's day get mail, and the conversational ones — a
 * comment, a completion, a reopen — stay in the tray, where they cost nothing to ignore. Every
 * trigger still ALLOWS mail, so anyone can turn theirs on.
 */
export const NOTIFICATION_TRIGGERS: Record<NotificationTriggerKey, NotificationTriggerSpec> = {
  task_assigned: {
    group: "tasks",
    title: "{actor} assigned you: {task}",
    when: "Someone is added to a task's assignees.",
    why: "Work handed to you should reach you, not wait to be noticed on the board.",
    source: "event",
    defaultRecipients: ["assignee"],
    defaultInApp: true,
    defaultEmail: true,
    defaultSound: true,
    mandatory: false,
  },
  task_comment: {
    group: "discussion",
    title: "{actor} commented on: {task}",
    when: "A comment is posted on a task.",
    why: "A question asked on a card is answered only if the people on it hear about it.",
    source: "event",
    defaultRecipients: ["assignee", "author", "participant"],
    defaultInApp: true,
    defaultEmail: false,
    defaultSound: true,
    mandatory: false,
  },
  task_deadline_changed: {
    group: "tasks",
    title: "Deadline moved to {deadline}: {task}",
    when: "A task's deadline is written to a different value.",
    why: "The date you planned your week around changed, and nothing else would say so.",
    source: "event",
    defaultRecipients: ["assignee"],
    defaultInApp: true,
    defaultEmail: false,
    defaultSound: false,
    mandatory: false,
  },
  task_deadline_near: {
    group: "tasks",
    // `{when}` is "tomorrow", "in 3 days" — supplied by the sweep, which knows what the firm set.
    // It said "Due tomorrow" outright until the lead time became a setting (S9.2), at which point
    // the line would have been a lie on every firm that changed it.
    title: "Due {when}: {task}",
    when: "The deadline is close — how close is set by the firm, and checked once a day.",
    why: "One day's warning is the difference between finishing work and explaining it.",
    source: "sweep",
    defaultRecipients: ["assignee"],
    defaultInApp: true,
    defaultEmail: true,
    defaultSound: false,
    mandatory: false,
  },
  task_overdue: {
    group: "tasks",
    title: "Overdue: {task}",
    when: "The deadline has passed and the task is still open. Once per task, ever.",
    why: "Late work stops being visible the moment it scrolls off the board.",
    source: "sweep",
    defaultRecipients: ["assignee"],
    defaultInApp: true,
    defaultEmail: true,
    defaultSound: false,
    mandatory: false,
  },
  task_done: {
    group: "tasks",
    title: "{actor} completed: {task}",
    when: "A task is completed by somebody other than the person who created it.",
    why: "Whoever asked for the work is the one waiting on it.",
    source: "event",
    defaultRecipients: ["author"],
    defaultInApp: true,
    defaultEmail: false,
    defaultSound: false,
    mandatory: false,
  },
  task_reopened: {
    group: "tasks",
    title: "{actor} reopened: {task}",
    when: "A completed task is put back to open.",
    why: "Work you had finished is yours again, and the board alone will not say it.",
    source: "event",
    defaultRecipients: ["assignee"],
    defaultInApp: true,
    defaultEmail: false,
    defaultSound: false,
    mandatory: false,
  },
  task_cancelled: {
    group: "tasks",
    title: "{actor} cancelled: {task}",
    when: "A task is called off.",
    why: "Stopping work you were about to start is only possible if you hear in time.",
    source: "event",
    defaultRecipients: ["assignee"],
    defaultInApp: true,
    defaultEmail: false,
    defaultSound: false,
    mandatory: false,
  },
  meeting_invited: {
    group: "meetings",
    title: "{actor} invited you: {meeting}",
    when: "You are added to a meeting's participants.",
    why: "A meeting booked in your diary by someone else is the definition of news.",
    source: "event",
    defaultRecipients: ["participant"],
    defaultInApp: true,
    defaultEmail: true,
    defaultSound: true,
    mandatory: false,
  },
  meeting_today: {
    group: "meetings",
    title: "Today at {time}: {meeting}",
    when: "A meeting you are in starts today.",
    why: "The calendar is a screen people open, not one they live on.",
    source: "sweep",
    defaultRecipients: ["participant"],
    defaultInApp: true,
    defaultEmail: true,
    defaultSound: false,
    mandatory: false,
  },
  meeting_moved: {
    group: "meetings",
    title: "Moved to {when}: {meeting}",
    when: "A meeting's start time is written to a different instant.",
    why: "Turning up to a moved meeting is the failure this exists to prevent.",
    source: "event",
    defaultRecipients: ["participant"],
    defaultInApp: true,
    defaultEmail: true,
    defaultSound: true,
    mandatory: false,
  },
  meeting_cancelled: {
    group: "meetings",
    title: "{actor} cancelled: {meeting}",
    when: "A meeting is called off.",
    why: "Turning up to a meeting that is not happening is the one outcome worse than missing it.",
    source: "event",
    /**
     * Participants AND the task's assignees. They start out as the same people — `openTaskFor`
     * assigns a meeting's task to whoever is coming — but a task can be handed on afterwards, and
     * the person now holding "prepare for Tuesday's review" is the one who needs to hear that
     * Tuesday's review is off. The task is deliberately NOT cancelled with the meeting: whether
     * the preparation is still worth doing is a person's call, not the system's (user,
     * 2026-09-06).
     */
    defaultRecipients: ["participant", "assignee"],
    defaultInApp: true,
    defaultEmail: true,
    defaultSound: true,
    mandatory: false,
  },
  meeting_restored: {
    group: "meetings",
    title: "{actor} put it back on: {meeting}",
    when: "A cancelled meeting is reinstated.",
    why: "Somebody who rearranged their day around the cancellation has to hear it is back.",
    source: "event",
    defaultRecipients: ["participant"],
    defaultInApp: true,
    defaultEmail: true,
    defaultSound: false,
    mandatory: false,
  },
  meeting_uninvited: {
    group: "meetings",
    title: "{actor} took you off: {meeting}",
    when: "You are removed from a meeting's participants.",
    why: "The meeting simply vanishes from your calendar, and nothing else would say why.",
    source: "event",
    // `participant` cannot find them — they are not one any more — so the emitter is called once
    // per removed person, addressed to them by `self`.
    defaultRecipients: ["self"],
    defaultInApp: true,
    defaultEmail: false,
    defaultSound: false,
    mandatory: false,
  },
  meeting_soon: {
    group: "meetings",
    title: "Starts {when}: {meeting}",
    when: "Shortly before a meeting that was booked with a reminder.",
    why: "`meeting_today` is for planning the day; this is for the five minutes before you are late.",
    source: "sweep",
    defaultRecipients: ["participant"],
    defaultInApp: true,
    // a letter fifteen minutes ahead arrives after the moment it was for, and lands in an inbox
    // nobody is watching. The chime is the point of this one.
    defaultEmail: false,
    defaultSound: true,
    mandatory: false,
  },
  invoice_overdue: {
    group: "billing",
    title: "Invoice {number} is overdue — {client}",
    when: "An invoice passes its due day still unpaid. Once per invoice, ever.",
    why: "Debt that nobody is told about is debt nobody chases.",
    source: "sweep",
    defaultRecipients: ["admin", "custom"],
    defaultInApp: true,
    defaultEmail: true,
    defaultSound: false,
    mandatory: false,
  },
  ops_mailbox_broken: {
    group: "ops",
    title: "Mailbox {mailbox} could not be read",
    when: "A configured mailbox fails to authenticate or cannot be read.",
    why: "A mailbox that stops being read stops catching bounces, silently, forever.",
    source: "sweep",
    defaultRecipients: ["admin", "custom"],
    defaultInApp: true,
    defaultEmail: true,
    defaultSound: false,
    mandatory: false,
  },
  ops_sweep_failed: {
    group: "ops",
    title: "{sweep} reported failures",
    when: "A generating sweep finishes having skipped work it could not do.",
    why: "A client who quietly stops being billed is only visible in the logs otherwise.",
    source: "sweep",
    defaultRecipients: ["admin", "custom"],
    defaultInApp: true,
    defaultEmail: true,
    defaultSound: false,
    mandatory: false,
  },
  ops_mailout_errors: {
    group: "ops",
    // `{failed}` arrives ALREADY counted ("1 letter" / "4 letters") — the emitter has the number
    // and the template has no way to pluralise. "1 letters were not delivered" shipped for an
    // afternoon before a live run showed it (2026-09-05).
    title: "{failed} not delivered: {mailout}",
    when: "A send finishes with failed recipients.",
    why: "The person who pressed Send has moved on by the time the run closes.",
    source: "event",
    // The sender IS the author of the run, so `author` is the role — and they are NOT the actor
    // here: nobody performs the act of a delivery failing, which is why §5.4's "never notify the
    // actor" does not silence the one person who needs this. `custom` stays for an admin copy.
    defaultRecipients: ["author", "custom"],
    defaultInApp: true,
    defaultEmail: true,
    defaultSound: false,
    mandatory: false,
  },
  timer_left_running: {
    group: "personal",
    title: "Your timer has been running since {since}",
    when: "A timer is still running from a previous day.",
    why: "An overnight timer turns into hours nobody worked, on an invoice somebody pays.",
    source: "sweep",
    defaultRecipients: ["self"],
    defaultInApp: true,
    defaultEmail: false,
    defaultSound: false,
    mandatory: false,
  },
};

export const NOTIFICATION_TRIGGER_KEYS = Object.keys(
  NOTIFICATION_TRIGGERS,
) as NotificationTriggerKey[];

/**
 * The nightly sweep's time, as the firm writes it, turned into the cron expression the scheduler
 * wants — in ONE place, because `server.ts` builds it at boot and the settings screen rebuilds it
 * on every save, and two copies of "minute hour * * *" would eventually disagree.
 *
 * The floor is 04:00, and it is not arbitrary: the task sweep runs at 03:05 and the invoice sweep
 * at 03:20, so an earlier notification sweep would scan deadlines before the day's generated work
 * exists and warn nobody about it. Anything unparseable falls back to the default rather than
 * throwing — a bad string in one column must not stop the server from booting.
 */
export const SWEEP_EARLIEST_HOUR = 4;
export const DEFAULT_SWEEP_AT = "07:00";

export function sweepCron(at: string | null | undefined): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec((at ?? "").trim());
  const [h, min] = m ? [Number(m[1]), Number(m[2])] : [7, 0];
  const valid = m !== null && h >= SWEEP_EARLIEST_HOUR && h <= 23 && min >= 0 && min <= 59;
  return valid ? `${min} ${h} * * *` : "0 7 * * *";
}

/** Is this something the settings screen may accept? Same rule, said as a question. */
export function isValidSweepAt(at: string): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
  if (!m) return false;
  const [h, min] = [Number(m[1]), Number(m[2])];
  return h >= SWEEP_EARLIEST_HOUR && h <= 23 && min >= 0 && min <= 59;
}

/**
 * Where a notification points — the ONE definition of it.
 *
 * There were two: `linkPath` in `server/core/notify.ts` built the URL for the letter's button and
 * `pathFor` in `notification-tray.tsx` built it for the tray's Open, as two switch statements over
 * the same link types that had to agree. They did, by luck. The comment above the server one even
 * claimed it was "in ONE place, so the tray's Open and the letter's button can never disagree",
 * which was the intention and not the fact (found in the audit, 2026-09-06).
 *
 * It belongs here because this file is the only one both sides may import: zero-dependency, and
 * already the source for everything else about a trigger.
 *
 * `linkType` is a free string on purpose — "thread" will work with no schema change — so an
 * unknown type is not an error. It resolves to the dashboard for a letter, and to nothing for the
 * tray, which is why the caller decides what a `null` means.
 */
export function notificationPath(
  linkType: string | null,
  linkId: string | null,
): string | null {
  if (!linkType) return null;
  switch (linkType) {
    case "task":
      return linkId ? `/tasks?task=${linkId}` : "/tasks";
    case "meeting":
      return linkId ? `/calendar?meeting=${linkId}` : "/calendar";
    case "invoice":
      return linkId ? `/billing?invoice=${linkId}` : "/billing";
    case "mailout":
      // the list, not a detail route: `/mailouts/:id` does not exist, and a link that 404s is
      // worse than one that lands on the screen the run is on
      return "/mailouts";
    case "mailbox":
      // Mailboxes live under Mailouts → Sender, NOT in Settings — which is where this pointed
      // until 2026-09-05, landing the reader on a screen with no mailbox on it
      return "/mailouts?tab=sender";
    default:
      return null;
  }
}

/**
 * `{name}` substitution, and nothing else.
 *
 * Shared so the tray line the emitter stores and any preview the settings screen shows come out of
 * the same function. A placeholder with no variable is left standing rather than blanked: a line
 * reading "{task}" is a visible bug, an empty one is a mystery.
 */
export function renderNotificationText(
  template: string,
  vars: Record<string, string | undefined>,
): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}

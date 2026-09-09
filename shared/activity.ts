/**
 * **Every act the product can record — the event registry.**
 *
 * This is the SOURCE, not a copy. `server/core/activity.ts` refuses a key that is not here, the
 * activity screen renders its filters and its sentences from here, and `ensureBaseData` seeds one
 * `ActivityPolicy` row per key. An event therefore cannot exist in the log and not on the screen,
 * or the reverse, and adding one is a constant plus a seeded row — never a migration. That is the
 * fourth time this file pattern carries a module (`system-tasks.ts`, `notifications.ts`,
 * `system-jobs.ts`, `access.ts`) and the reason "add subjects by hand later" costs nothing.
 *
 * NO IMPORTS, ever. The browser loads this, and importing a value out of a schema module drags the
 * zod runtime into the bundle (+433 kB — docs/architecture.md §5).
 *
 * ## The two lists, and why there are two
 *
 * `ACTIVITY_EVENTS` holds the events that are DECLARED: their subject, their sentence, what may
 * appear in their diff. `PLANNED_EVENT_KEYS` holds the rest of the measured inventory — real,
 * named, and not yet declared.
 *
 * The split is a build mechanic, not a smaller scope. The owner's decision (activity-log.md §4.5)
 * is that every measured event ships in one pass rather than in three, and the reason is that
 * enrichment means opening every service by hand. A spec is written when its service is opened —
 * `changeKeys` says which fields may move, and that is a fact about `updateClient`, not something
 * to guess from a name. So the planned list is the pass's checklist: each key moves up as its
 * service is enriched, and `shared/activity.test.ts` fails if a key is in neither list or in both.
 *
 * ## The count lives in the test, not in this comment
 *
 * `shared/activity.test.ts` asserts the exact number of declared keys, so a key added or removed
 * without somebody meaning it fails the build. It is deliberately NOT written here or in any of the
 * six other places that used to carry it: the drafts said 138, then 136, while the registry grew
 * past both, and every one of those numbers had to be believed by a reader who could not check it.
 * A number a test does not hold is a number that goes stale (audit, 2026-09-09).
 *
 * Two events the spec listed were dropped rather than built: §4.4 named `system.job_ran` and
 * `system.tasks_generated`, and §3.3 of the same document forbids both — `JobEvent` already writes
 * every run that did something, with a better note than this module could compose, and the System
 * tab already reads them. `task.generated` covers the second from the side a person actually asks
 * it from: the board, not the job list.
 */

// ── the vocabulary ───────────────────────────────────────────────────────────

/**
 * The filter strip on the screen. The registry holds far more keys than fit one row of chips, so
 * the group is load-bearing rather than decorative (activity-log.md §4.5).
 */
export type ActivityGroup =
  | "people"
  | "clients"
  | "work"
  | "money"
  | "comms"
  | "files"
  | "system";

/**
 * The thing an event happened TO. Always equal to the segment before the dot in the key — no
 * `mail.`, no `notifications.`, no `template.` unless that is a subject.
 *
 * `person` and `payment` are deliberately absent: contacts are `client.people_changed` because
 * `ClientPerson` is deleted and recreated on every save, so no person id survives to be a subject;
 * and payments are events on their invoice (activity-log.md §4.3).
 */
export type ActivitySubject =
  | "client"
  | "company"
  | "subscription"
  | "secret"
  | "lead"
  | "task"
  | "time_entry"
  | "meeting"
  | "invoice"
  | "service"
  | "mailout"
  | "campaign"
  | "mailbox"
  | "file"
  | "user"
  | "session"
  | "access"
  | "settings"
  | "system";

/** Beside the registry, so adding a subject costs one line and cannot be misfiled. */
export const SUBJECT_GROUP: Record<ActivitySubject, ActivityGroup> = {
  client: "clients",
  company: "clients",
  subscription: "clients",
  secret: "clients",
  lead: "clients",
  task: "work",
  time_entry: "work",
  meeting: "work",
  invoice: "money",
  service: "money",
  mailout: "comms",
  campaign: "comms",
  mailbox: "comms",
  file: "files",
  user: "people",
  session: "people",
  access: "people",
  settings: "system",
  system: "system",
};

/**
 * **Which gate governs each subject — the map that stops the log becoming a way around one.**
 *
 * activity-log.md §12 rule 1 says the screen "must not become a way to read what a gate closed",
 * and until 2026-09-08 that was true only because the `activity` gate ships closed for everyone
 * but an admin. The moment a firm opens it to a lead — which is the whole reason the gate exists —
 * a subject label is a client name, and a closed `clients` gate would have stopped meaning
 * anything. Contained by a default is not contained.
 *
 * So a reader sees the subjects they could already open. The gate names are plain strings rather
 * than `GateKey` because this file imports nothing (the browser loads it); `shared/activity.test.ts`
 * holds the two lists to each other.
 */
export const SUBJECT_GATE: Record<ActivitySubject, string> = {
  client: "clients",
  company: "clients",
  subscription: "clients",
  secret: "secrets",
  lead: "leads",
  task: "tasks",
  time_entry: "tasks",
  meeting: "calendar",
  invoice: "billing",
  service: "services",
  mailout: "mailouts",
  campaign: "mailouts",
  mailbox: "mailboxes",
  // a file belongs to the client or the task it hangs off; `clients` is the wider of the two
  file: "clients",
  // who is in the system, and what they were allowed to reach — the Team gate's subject matter
  user: "team",
  session: "team",
  access: "team",
  settings: "settings",
  system: "settings",
};

/** Mirrors the Prisma enum. Declared rather than imported — see the no-imports rule above. */
export type ActorKind = "user" | "client" | "system";
export type ActivityOutcome = "ok" | "refused" | "failed";

/** The journals that keep the DETAIL this log only points at (activity-log.md §9, §4.6). */
export type ActivityJournal =
  | "payment"
  | "secret"
  | "time_entry"
  | "user_role"
  | "subscription_period"
  | "job_event";

export interface ActivityEventSpec {
  subject: ActivitySubject;
  /**
   * The sentence, rendered from the row by `renderTitle` — **exactly two placeholders**,
   * `{actor}` and `{subject}`, each with exactly one source: `actorLabel` and `subjectLabel`.
   *
   * The first draft also had `{count}` and `{detail}`, and they were removed on 2026-09-08 while
   * building the screen. Neither had a source: `{count}` would have had to guess which key of
   * `changes` was the number (`created` for an import, `recipients` for a campaign, `failed` for a
   * send), and `{detail}` was `{subject}` under another name. A placeholder whose value is guessed
   * is a sentence that is wrong on some rows and right on others, which is the worst of both. The
   * counts appear in the expanded detail, which is where a reader who wants them is already
   * looking.
   */
  title: string;
  /** plain words, for the screen's legend */
  when: string;
  /**
   * `item` — one row per thing, so `[subject, subjectId]` finds it. `summary` — one row with a
   * count, for a fan-out or a sweep whose per-item record already exists elsewhere (§4.2).
   */
  granularity: "item" | "summary";
  /** several keys legitimately arrive as a person OR as the scheduler. One act, one key. */
  actorKinds: ActorKind[];
  retention: "ordinary" | "long";
  /**
   * The only keys `changes` may hold — and its ABSENCE means the event carries no diff at all.
   *
   * Both halves are enforced (`core/activity.ts`), which is what makes §14's "`changes` never
   * contains a field the caller did not change" testable in one loop rather than by reading forty
   * services. Declaring a key here is a fact about the service, so it is written when that service
   * is opened, never guessed from the event's name.
   */
  changeKeys?: string[];
  /** where the fuller record lives, for the screen's "see the detail" link */
  journal?: ActivityJournal;
  /** one row per key per window, with a count — for the failures that repeat every 15 minutes */
  dedupe?: { key: string; windowMinutes: number };
  /** seeded into `ActivityPolicy`; the firm may switch it afterwards without a deploy */
  enabledByDefault: boolean;
  /** reading IS the act — the sensitive reads of §3.2, where opening a record is the event */
  isRead?: boolean;
}

// ── the registry ─────────────────────────────────────────────────────────────

const EVENTS = {
  // ── session: who is in the system ──────────────────────────────────────────
  // Three of the four record acts the product cannot reconstruct at all today, which is why they
  // lead the build order (activity-log.md §4.5).
  "session.signed_in": {
    subject: "session",
    title: "{actor} signed in",
    when: "a person signs in successfully",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    enabledByDefault: true,
  },
  "session.signed_out": {
    subject: "session",
    title: "{actor} signed out",
    when: "a person signs out",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    enabledByDefault: true,
  },
  /**
   * Nothing in the product records a failed sign-in. Not the session table, not the audit journals,
   * not the logs — a hundred attempts against one account leave no trace anybody can find. This is
   * also what the security package's failed-login detection will read, rather than building a
   * second table of its own (§15).
   */
  "session.sign_in_failed": {
    subject: "session",
    title: "Failed sign-in for {subject}",
    when: "a sign-in is refused — wrong password, unknown address, or a blocked account",
    granularity: "item",
    actorKinds: ["system"],
    retention: "long",
    changeKeys: ["email", "reason"],
    enabledByDefault: true,
  },
  /**
   * The permissions module decides and logs nothing (`permissions.md` §20.3 defers exactly this
   * gap here). Written by the tier-1 hook rather than by a service: the refusal happens in
   * `accessHook`, before any service is reached.
   */
  "session.gate_refused": {
    subject: "session",
    title: "{actor} was refused {subject}",
    when: "a closed gate, a read-only gate or an admin-only route refuses a request",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    enabledByDefault: true,
  },

  // ── access: what they were allowed to reach ────────────────────────────────
  // Policies and overrides are upserted in place with no actor and no prior state, so "who took
  // this away from me, and when" has no answer today (`permissions.md` §20.3).
  "access.policy_changed": {
    subject: "access",
    title: "{actor} changed access to {subject}",
    when: "a gate's state is changed for a role",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    /**
     * The state alone. The gate and the role are the subject's IDENTITY, not a change — they are in
     * `subjectLabel`, where a screen reads them without unpacking JSON. Written from the service
     * once it was opened (2026-09-08), which is the rule: a declared key is a fact about the code.
     */
    changeKeys: ["state"],
    enabledByDefault: true,
  },
  "access.override_set": {
    subject: "access",
    title: "{actor} set a personal access rule for {subject}",
    when: "one person's access to a gate is set apart from their role",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    changeKeys: ["state"],
    enabledByDefault: true,
  },
  "access.override_cleared": {
    subject: "access",
    title: "{actor} removed the personal access rule for {subject}",
    when: "a personal rule is removed and the person follows their role again",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    changeKeys: ["state"],
    enabledByDefault: true,
  },

  // ── user: the account lifecycle ────────────────────────────────────────────
  // `long` throughout: an account is an access decision, and these are the rows an examination or
  // a dispute asks about (§11).
  "user.invited": {
    subject: "user",
    title: "{actor} invited {subject}",
    when: "an invitation is sent to a new colleague",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    changeKeys: ["email", "role"],
    enabledByDefault: true,
  },
  "user.invite_accepted": {
    subject: "user",
    title: "{subject} accepted the invitation",
    when: "an invited person sets their password and the account becomes real",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    enabledByDefault: true,
  },
  "user.role_changed": {
    subject: "user",
    title: "{actor} changed {subject}'s role",
    when: "somebody is made an admin, or stops being one",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    changeKeys: ["role"],
    journal: "user_role",
    enabledByDefault: true,
  },
  "user.blocked": {
    subject: "user",
    title: "{actor} blocked {subject}",
    when: "an account is blocked and every session it holds stops working",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    changeKeys: ["status"],
    enabledByDefault: true,
  },
  "user.unblocked": {
    subject: "user",
    title: "{actor} unblocked {subject}",
    when: "a blocked account is let back in",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    changeKeys: ["status"],
    enabledByDefault: true,
  },
  "user.password_changed": {
    subject: "user",
    title: "{subject} changed their password",
    when: "a person changes their own password while signed in",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    enabledByDefault: true,
  },
  "user.password_reset_requested": {
    subject: "user",
    title: "A password reset was requested for {subject}",
    when: "the forgotten-password form is submitted for an address",
    granularity: "item",
    actorKinds: ["system"],
    retention: "long",
    /**
     * `known` is why an unknown address is recorded at all: the route stays silent either way, but a
     * run of resets aimed at addresses that do not exist is the clearest signal of somebody working
     * through a list.
     */
    changeKeys: ["email", "known"],
    enabledByDefault: true,
  },
  "user.password_reset": {
    subject: "user",
    title: "{subject} reset their password",
    when: "a reset link is used and the password actually changes",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    enabledByDefault: true,
  },
  /**
   * The only account that exists before anybody is invited. A security event, recorded as one; the
   * seeded configuration rows around it are not (§3.3).
   */
  "user.first_admin_created": {
    subject: "user",
    title: "The first admin account was created for {subject}",
    when: "a database with no users boots and `ensureBootstrapAdmin` creates one",
    granularity: "item",
    actorKinds: ["system"],
    retention: "long",
    changeKeys: ["email"],
    enabledByDefault: true,
  },

  "user.invite_resent": {
    subject: "user",
    title: "{actor} sent {subject} a new invitation",
    when: "an invitation is issued again — the previous link stops working",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    enabledByDefault: true,
  },
  /**
   * A person's own name. Not `long`: it is the one thing in this subject that is not an access
   * decision, and a name change two years old settles no dispute.
   */
  "user.profile_changed": {
    subject: "user",
    title: "{subject} changed their name",
    when: "somebody edits their own profile",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["firstName", "lastName"],
    enabledByDefault: true,
  },

  // ── client: whose data was touched ─────────────────────────────────────────
  "client.created": {
    subject: "client",
    title: "{actor} added the client {subject}",
    when: "a client is created, by hand or by converting a lead",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "client.updated": {
    subject: "client",
    title: "{actor} updated {subject}",
    when: "a field on the client card changes — and only when one actually moved",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    /**
     * The eight fields `clientFields` carries, read off the schema when `clients.service.ts` was
     * opened (2026-09-08). The companies and the people are NOT here: they are lists rather than
     * fields, and they have their own events.
     */
    changeKeys: [
      "firstName",
      "lastName",
      "companyName",
      "phone",
      "email",
      "address",
      "sourceId",
      "description",
    ],
    enabledByDefault: true,
  },
  "client.archived": {
    subject: "client",
    title: "{actor} archived {subject}",
    when: "a client is archived and their services stop",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "client.restored": {
    subject: "client",
    title: "{actor} restored {subject}",
    when: "an archived client is brought back",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  /**
   * A client silently became unreachable. Asked on the client's card, never on the job — which is
   * why it is in the general log and `JobEvent`'s own record of the run is not (§3.3).
   */
  "client.email_retired": {
    subject: "client",
    title: "{subject}'s address stopped receiving mail",
    when: "a receiving server rejects an address and the sweep retires it",
    granularity: "item",
    actorKinds: ["system"],
    retention: "ordinary",
    changeKeys: ["email", "reason"],
    enabledByDefault: true,
  },
  /**
   * `scripts/import-clients.ts` created 177 clients and `scripts/import-contacts.ts` 84 more — the
   * biggest writes this database has ever seen, and they left no trace anywhere. One row with a
   * count and the source file, not a row per client (§3.3).
   */
  "client.imported": {
    subject: "client",
    title: "Clients imported from {subject}",
    when: "an import script runs",
    granularity: "summary",
    actorKinds: ["system"],
    retention: "ordinary",
    changeKeys: ["file", "created", "updated", "skipped"],
    enabledByDefault: true,
  },
  /**
   * A summary because `ClientPerson` rows are deleted and recreated on every save, so no person id
   * survives to be a subject (§4.3).
   */
  "client.people_changed": {
    subject: "client",
    title: "{actor} changed the contacts of {subject}",
    when: "the people on a client card are added, edited or removed",
    granularity: "summary",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["added", "removed", "changed"],
    enabledByDefault: true,
  },

  // ── secret: the vault ──────────────────────────────────────────────────────
  /**
   * Only when a field moved. A save that carries only the per-client task overrides still reaches
   * `updateSubscription`, and firing on that would put a row in the log every time the form was
   * opened and closed.
   */
  "subscription.updated": {
    subject: "subscription",
    title: "{actor} changed {subject}",
    when: "a service's price, period, company or billing timing changes on a client",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: [
      "amount",
      "period",
      "companyId",
      "invoiceTrigger",
      "invoiceDay",
      "dueDays",
      "isDefault",
    ],
    journal: "subscription_period",
    enabledByDefault: true,
  },
  /**
   * **Pausing is a DATE, not a flag** — it is what lets the system still answer "was this client
   * served on the 1st" months later, which is what decides billing and generation. So the last day
   * served is the event's whole content.
   */
  "subscription.paused": {
    subject: "subscription",
    title: "{actor} paused {subject}",
    when: "a service is given a last served day",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["lastDay", "note"],
    journal: "subscription_period",
    enabledByDefault: true,
  },
  "subscription.resumed": {
    subject: "subscription",
    title: "{actor} resumed {subject}",
    when: "a paused service is served again from a date",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["startsOn", "note"],
    journal: "subscription_period",
    enabledByDefault: true,
  },
  /** Removing an end date is the opposite of switching a service off, and reads differently. */
  "subscription.pause_cancelled": {
    subject: "subscription",
    title: "{actor} called off the pause on {subject}",
    when: "a scheduled pause is removed and the service goes back to open-ended",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    journal: "subscription_period",
    enabledByDefault: true,
  },
  /**
   * A period that has not started yet is not paused, it is cancelled — the row is dropped rather
   * than left as a zero-length stub. Recorded separately because the service never ran at all.
   */
  "subscription.start_cancelled": {
    subject: "subscription",
    title: "{actor} cancelled the start of {subject}",
    when: "a service agreed for a future date is called off before it begins",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["startsOn"],
    journal: "subscription_period",
    enabledByDefault: true,
  },
  /**
   * Stopped BY the archive, not by a person pausing it — a different fact with a different cause,
   * and the one somebody looking at a stopped service six months later needs. Recorded per
   * subscription, sharing the archive's correlation id (§4.2, clause 1).
   */
  "subscription.stopped": {
    subject: "subscription",
    title: "{subject} stopped — the client was archived",
    when: "a client is archived and their running services stop that day",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    journal: "subscription_period",
    enabledByDefault: true,
  },
  /**
   * **The one event that ships present and OFF** (activity-log.md §3.2).
   *
   * It is the event that would let the firm scope a breach precisely — "whose cards were opened,
   * and by whom" — and the noisiest in the product, because it fires on every navigation. A firm
   * that has reason to turn it on can, on the Settings screen, without a deploy.
   *
   * Recorded on the ROUTE that serves a card, not in `getClient`: that function is called by a
   * dozen mutations to build their response, and recording there would log a "view" every time
   * anybody saved anything.
   */
  "client.viewed": {
    subject: "client",
    title: "{actor} opened {subject}",
    when: "somebody opens a client's card — OFF by default, because it fires on every navigation",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: false,
    isRead: true,
  },
  "client.mail_subscription_changed": {
    subject: "client",
    title: "{actor} changed whether {subject} receives mail",
    when: "a client is unsubscribed from commercial mail by the firm, or put back on the list",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["subscribed"],
    enabledByDefault: true,
  },
  /**
   * The other half of `client.email_retired`. The block is INFERRED and inference can be wrong — a
   * classification may misread a server's wording, and a deleted mailbox can be recreated — so
   * somebody vouching for an address is a decision with an owner, and the pair reads as a story.
   */
  "client.email_revived": {
    subject: "client",
    title: "{actor} vouched for an address of {subject}",
    when: "a blocked address is unblocked by hand",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["email"],
    enabledByDefault: true,
  },
  /**
   * **A client silently stopped being billed.** The sweep isolates failures per subscription so one
   * bad row cannot stop the firm's billing run — which is right, and which is also how a client can
   * go months without an invoice while every night's job reports "ok". `JobEvent` carries the
   * count; this carries WHICH ONE, on the client's card, where somebody would notice.
   *
   * Deduped to one row a day per subscription: the sweep runs nightly and a row every night for
   * six months would bury the first one, which is the one that mattered.
   */
  "subscription.generation_failed": {
    subject: "subscription",
    title: "{subject} could not be billed automatically",
    when: "the nightly invoice sweep fails on one subscription",
    granularity: "item",
    actorKinds: ["system"],
    retention: "ordinary",
    changeKeys: ["error"],
    dedupe: { key: "subscriptionId", windowMinutes: 1440 },
    enabledByDefault: true,
  },
  "secret.created": {
    subject: "secret",
    title: "{actor} stored the secret {subject}",
    when: "a credential is added to a client's vault",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    journal: "secret",
    enabledByDefault: true,
  },
  /** Reading IS the act. Already journalled with an IP — the pattern the other reads follow. */
  "secret.revealed": {
    subject: "secret",
    title: "{actor} revealed the secret {subject}",
    when: "a stored credential is decrypted and shown",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    journal: "secret",
    enabledByDefault: true,
    isRead: true,
  },
  /**
   * Moved out of `PLANNED_EVENT_KEYS` on 2026-09-08, when `secrets.service.ts` was opened for the
   * rest of its events — and worth having for a reason the plan did not anticipate: the journal
   * records `updated` with no indication of whether the CREDENTIAL changed or only its label, and
   * "was the password rotated" is the question asked after a departure.
   *
   * `value` never holds a value. It holds what happened to one.
   */
  "secret.updated": {
    subject: "secret",
    title: "{actor} changed the secret {subject}",
    when: "a stored credential's label, description or value is edited",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["label", "description", "value"],
    journal: "secret",
    enabledByDefault: true,
  },
  "secret.deleted": {
    subject: "secret",
    title: "{actor} deleted the secret {subject}",
    when: "a stored credential is destroyed",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    journal: "secret",
    enabledByDefault: true,
  },
  /**
   * The journal records failures and reveals but never a SUCCESS, so "seven failures" cannot today
   * be told apart from "seven failures and then they got in" (§4.5).
   */
  "secret.vault_unlocked": {
    subject: "secret",
    title: "{actor} unlocked the vault",
    when: "the vault password is accepted and a reveal window opens",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    enabledByDefault: true,
  },
  "secret.unlock_failed": {
    subject: "secret",
    title: "{actor} failed to unlock the vault",
    when: "the vault password is refused",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    journal: "secret",
    enabledByDefault: true,
  },

  // ── invoice: money ─────────────────────────────────────────────────────────
  /**
   * Arrives from a person AND from the nightly sweep — one key, two actors, which is the whole
   * reason `actorKinds` is a list (§4.3). "Where did this invoice come from" is asked on the
   * invoice, not on the job.
   */
  "invoice.issued": {
    subject: "invoice",
    title: "Invoice {subject} was issued",
    when: "an invoice is created by hand or by the period sweep",
    granularity: "item",
    actorKinds: ["user", "system"],
    retention: "ordinary",
    // not the client's NAME: `issueInvoice` runs on the nightly sweep and would need a lookup per
    // invoice to carry one, when `clientId` already lets the screen resolve it (2026-09-08)
    changeKeys: ["number", "amount"],
    enabledByDefault: true,
  },
  "invoice.updated": {
    subject: "invoice",
    title: "{actor} corrected invoice {subject}",
    when: "an issued invoice's amount, note, due date or positions are changed",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["amount", "description", "dueDate"],
    journal: "payment",
    enabledByDefault: true,
  },
  "invoice.payment_edited": {
    subject: "invoice",
    title: "{actor} corrected a payment on invoice {subject}",
    when: "a mistyped payment is fixed",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    changeKeys: ["amount", "paidAt", "reference"],
    journal: "payment",
    enabledByDefault: true,
  },
  "invoice.marked_sent": {
    subject: "invoice",
    title: "{actor} marked invoice {subject} as sent",
    when: "an invoice is recorded as handed to the client",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "invoice.sent_unmarked": {
    subject: "invoice",
    title: "{actor} took back the sent mark on invoice {subject}",
    when: "a mis-click on the sent mark is undone",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "invoice.tidied": {
    subject: "invoice",
    title: "{actor} tidied invoice {subject} away",
    when: "a settled invoice is moved out of the working lists",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "invoice.untidied": {
    subject: "invoice",
    title: "{actor} brought invoice {subject} back",
    when: "a tidied invoice is put back in the working lists by hand",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  /**
   * **The app doing it, not a person.** A later correction — a deleted payment, a raised amount —
   * can put money back on an invoice that was already tidied away, and an owed invoice must never
   * stay hidden, so it returns by itself. Its own key because an unexplained reappearance in the
   * working list is otherwise indistinguishable from somebody having done it.
   */
  "invoice.untidied_owed": {
    subject: "invoice",
    title: "Invoice {subject} came back — it is owed again",
    when: "a correction puts money back on an invoice that had been tidied away",
    granularity: "item",
    actorKinds: ["user", "system"],
    retention: "ordinary",
    changeKeys: ["balance"],
    enabledByDefault: true,
  },
  "invoice.cancelled": {
    subject: "invoice",
    title: "{actor} cancelled invoice {subject}",
    when: "an issued invoice is cancelled",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    journal: "payment",
    enabledByDefault: true,
  },
  "invoice.payment_recorded": {
    subject: "invoice",
    title: "{actor} recorded a payment on invoice {subject}",
    when: "money is registered against an invoice, singly or in a bulk mark-paid",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["amount", "paidAt"],
    journal: "payment",
    enabledByDefault: true,
  },
  "invoice.payment_deleted": {
    subject: "invoice",
    title: "{actor} deleted a payment on invoice {subject}",
    when: "a recorded payment is removed",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    changeKeys: ["amount", "paidAt"],
    journal: "payment",
    enabledByDefault: true,
  },

  // ── file: the bytes ────────────────────────────────────────────────────────
  "file.uploaded": {
    subject: "file",
    title: "{actor} uploaded {subject}",
    when: "a document is attached to a client or a task",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    // `attachedTo` names the client or the task, not the KIND of thing — "attachedTo: task"
    // told a reader a file went somewhere and not where (2026-09-08)
    changeKeys: ["name", "size", "attachedTo"],
    enabledByDefault: true,
  },
  /** The only way to answer "whose documents were taken" after a compromise (§3.2). */
  "file.downloaded": {
    subject: "file",
    title: "{actor} downloaded {subject}",
    when: "a stored document is fetched",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
    isRead: true,
  },
  /**
   * The bytes on disk that no row points at any more. A summary, because the count is the whole
   * content: the files themselves were already deleted as records, and this is the housekeeping
   * that finally removes what they left behind.
   */
  "file.bytes_pruned": {
    subject: "file",
    title: "Orphaned files were removed from disk",
    when: "`scripts/prune-uploads.ts` deletes file bytes nothing points at",
    granularity: "summary",
    actorKinds: ["system"],
    retention: "long",
    changeKeys: ["removed", "bytes"],
    enabledByDefault: true,
  },
  "file.deleted": {
    subject: "file",
    title: "{actor} deleted {subject}",
    when: "a document is removed from a client or a task",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    changeKeys: ["name", "attachedTo"],
    enabledByDefault: true,
  },

  // ── task: the biggest subject, and the one whose lifecycle is a decision ───
  //
  // Split the way `notifyTaskChanges` already splits it (§4.1's closed verbs did the rest): the
  // LIFECYCLE facts get their own key each, because each one changes what somebody does next and is
  // asked about by name; everything else is a field diff under `task.updated`.
  "task.created": {
    subject: "task",
    title: "{actor} created the task {subject}",
    when: "a job is raised by a person",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["kind", "client", "deadline"],
    enabledByDefault: true,
  },
  "task.updated": {
    subject: "task",
    title: "{actor} edited the task {subject}",
    when: "a field on a task changes that is not one of the lifecycle events below",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["title", "description", "priorityId", "plannedMinutes", "amount"],
    enabledByDefault: true,
  },
  "task.assigned": {
    subject: "task",
    title: "{actor} changed who is on {subject}",
    when: "the people assigned to a task change",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["assignees"],
    enabledByDefault: true,
  },
  /**
   * Its own key rather than a field of `task.updated`: a deadline moving is the one edit whose blast
   * radius reaches other people's plans, and §4.1 reserves `<field>_changed` for exactly that.
   */
  "task.deadline_changed": {
    subject: "task",
    title: "{actor} moved the deadline of {subject}",
    when: "a task's deadline is set, moved or cleared",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["deadline"],
    enabledByDefault: true,
  },
  "task.completed": {
    subject: "task",
    title: "{actor} completed {subject}",
    when: "a task is marked done",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "task.reopened": {
    subject: "task",
    title: "{actor} reopened {subject}",
    when: "a completed task is put back into the work",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  /** Cancelling is a decision, and the row is kept precisely so the decision has a record. */
  "task.cancelled": {
    subject: "task",
    title: "{actor} called off {subject}",
    when: "a task is cancelled — raised by mistake, or called off",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "task.uncancelled": {
    subject: "task",
    title: "{actor} restored the cancelled task {subject}",
    when: "a cancelled task is taken back",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "task.archived": {
    subject: "task",
    title: "{actor} archived {subject}",
    when: "a task is archived, singly or in a bulk selection",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "task.restored": {
    subject: "task",
    title: "{actor} restored {subject}",
    when: "an archived task is brought back",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  /**
   * A card moved between columns IS the work rather than a fact about it, and it happens dozens of
   * times a day — which is why the notifications module deliberately does not raise one. It is
   * recorded here anyway, and only here, because the log's question is different: "where did this
   * job get stuck" is answered by nothing else in the product.
   */
  "task.column_changed": {
    subject: "task",
    title: "{actor} moved {subject} to another column",
    when: "a card is dragged to a different column of the board",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["column"],
    enabledByDefault: true,
  },
  "task.commented": {
    subject: "task",
    title: "{actor} commented on {subject}",
    when: "somebody writes in a task's thread",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "task.comment_deleted": {
    subject: "task",
    title: "{actor} deleted a comment on {subject}",
    when: "a comment is removed by its author or by an admin",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    changeKeys: ["author"],
    enabledByDefault: true,
  },
  /**
   * **One summary per sweep, and only when it did something** (§4.2, clause 3). A night that raised
   * nothing writes nothing; `JobEvent` is what says the run happened at all.
   */
  "task.generated": {
    subject: "task",
    title: "Tasks were generated from subscriptions",
    when: "the nightly sweep creates the day's work from services and internal templates",
    granularity: "summary",
    actorKinds: ["system"],
    retention: "ordinary",
    changeKeys: ["created"],
    enabledByDefault: true,
  },
  /**
   * Not the same as `task.generated`: the product raised ONE job because something needs a person's
   * decision — a period it will not price by itself, a mailbox that stopped answering. Per item,
   * because the question is asked about that job.
   */
  "task.raised_by_system": {
    subject: "task",
    title: "The system raised {subject}",
    when: "the product creates a single task because something needs a person to decide",
    granularity: "item",
    actorKinds: ["system"],
    retention: "ordinary",
    changeKeys: ["kind"],
    enabledByDefault: true,
  },
  /**
   * A job's price follows its invoice, so the task never shows a different number from the one the
   * client was billed. Recorded because a price that moved without anybody touching the task is
   * exactly the kind of thing that looks like a bug six months later.
   */
  "task.amount_synced": {
    subject: "task",
    title: "The price of {subject} followed its invoice",
    when: "an invoice's amount is corrected and the linked job's price follows it",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["amount", "invoice"],
    enabledByDefault: true,
  },

  // ── the rest of the first pass ─────────────────────────────────────────────
  "company.created": {
    subject: "company",
    title: "{actor} added the company {subject}",
    when: "a company is added to a client card",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["name"],
    enabledByDefault: true,
  },
  /**
   * Only when a field actually moved. Every kept company is rewritten on every save — the
   * reconciliation carries `order` whether or not anything changed — and `order` is excluded
   * because dragging the second company above the first is not a change to either.
   */
  "company.updated": {
    subject: "company",
    title: "{actor} updated the company {subject}",
    when: "a company's name, phone, address or note changes",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["name", "phone", "email", "description"],
    enabledByDefault: true,
  },
  "company.deleted": {
    subject: "company",
    title: "{actor} removed the company {subject}",
    when: "a company is taken off a client card",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    // `Company` has no code — read off the model rather than assumed, 2026-09-08
    changeKeys: ["name"],
    enabledByDefault: true,
  },
  "subscription.created": {
    subject: "subscription",
    title: "{actor} started {subject}",
    when: "a client is given a paid service",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["service", "amount", "startedAt"],
    journal: "subscription_period",
    enabledByDefault: true,
  },
  /**
   * An admin entering time on somebody else's behalf. The ordinary case — a person running their
   * own timer — is NOT recorded: it happens dozens of times a day and IS the work, which is the
   * same line the notifications module draws.
   */
  "time_entry.created_manually": {
    subject: "time_entry",
    title: "{actor} entered time on {subject}",
    when: "an admin adds an interval of somebody's working time by hand",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["minutes", "whose"],
    journal: "time_entry",
    enabledByDefault: true,
  },
  "time_entry.updated": {
    subject: "time_entry",
    title: "{actor} corrected recorded time on {subject}",
    when: "a recorded interval's minutes or comment are changed",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    changeKeys: ["seconds", "comment", "whose"],
    journal: "time_entry",
    enabledByDefault: true,
  },
  "time_entry.deleted": {
    subject: "time_entry",
    title: "{actor} deleted recorded time on {subject}",
    when: "an interval of somebody's working time is destroyed",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    changeKeys: ["seconds", "comment", "whose"],
    journal: "time_entry",
    enabledByDefault: true,
  },
  /** Letters left the building unattended; asked from the campaign and from the client (§3.3). */
  "campaign.fired": {
    subject: "campaign",
    title: "Campaign {subject} was sent",
    when: "a scheduled campaign reaches its date and sends",
    granularity: "summary",
    actorKinds: ["system"],
    retention: "ordinary",
    // what it ADDRESSED, and the run it produced. Not "sent": the delivery log knows who actually
    // received a letter, and a count here that guessed would be the log's own lie (2026-09-08)
    changeKeys: ["recipients", "mailout"],
    enabledByDefault: true,
  },
  "mailout.send_failed": {
    subject: "mailout",
    title: "Letters from {subject} could not be sent",
    when: "a send run ends with failures",
    granularity: "summary",
    actorKinds: ["user", "system"],
    retention: "ordinary",
    // no `total`: the run reports how many failed, and the mailout's own delivery log is what
    // knows how many were attempted (2026-09-08)
    changeKeys: ["failed", "reason"],
    dedupe: { key: "subjectLabel", windowMinutes: 60 },
    enabledByDefault: true,
  },

  // ── lead: a real person's name, phone and email, before they are a client ──
  //
  // activity-log.md §4.4 left this subject empty — "the lead cluster's events fold into `client.*`
  // on conversion; leads have their own board history". The audit of 2026-09-08 overturned that:
  // the board history records stage moves, not who changed a prospect's phone number and not who
  // made the row disappear. A `Lead` holds a name, a phone, an email and a company — customer
  // information by every test §3.1 applies to a client — and Leads was the one module in the
  // product that changed things and recorded none of them.
  "lead.created": {
    subject: "lead",
    title: "{actor} added the lead {subject}",
    when: "a prospect is put on the pipeline",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["companyName", "serviceId"],
    enabledByDefault: true,
  },
  "lead.updated": {
    subject: "lead",
    title: "{actor} updated the lead {subject}",
    when: "a prospect's name, contacts, service or note changes",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["name", "companyName", "phone", "email", "serviceId", "sourceId", "description"],
    enabledByDefault: true,
  },
  "lead.stage_changed": {
    subject: "lead",
    title: "{actor} moved the lead {subject}",
    when: "a card moves to another stage of the pipeline",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["stage"],
    enabledByDefault: true,
  },
  /** Where a real client came from — the one lead event that outlives the pipeline. */
  "lead.converted": {
    subject: "lead",
    title: "{actor} converted the lead {subject} into a client",
    when: "a prospect becomes a client",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["client"],
    enabledByDefault: true,
  },
  "lead.marked_lost": {
    subject: "lead",
    title: "{actor} marked the lead {subject} lost",
    when: "a prospect is closed without becoming a client",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "lead.reopened": {
    subject: "lead",
    title: "{actor} reopened the lead {subject}",
    when: "a lost prospect is put back on the pipeline",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  /** Not an outcome — a soft delete, for duplicates, tests and mistakes. */
  "lead.archived": {
    subject: "lead",
    title: "{actor} archived the lead {subject}",
    when: "a lead is taken off every list — a duplicate, a test, a mistake",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "lead.restored": {
    subject: "lead",
    title: "{actor} restored the lead {subject}",
    when: "an archived lead is brought back",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  /** The pipeline's own columns, filed under `settings` beside the task board's. */
  "settings.stage_created": {
    subject: "settings",
    title: "{actor} added the pipeline stage {subject}",
    when: "a stage is added to the leads board",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "settings.stage_updated": {
    subject: "settings",
    title: "{actor} renamed the pipeline stage {subject}",
    when: "a stage of the leads board is renamed",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["name"],
    enabledByDefault: true,
  },
  "settings.stage_moved": {
    subject: "settings",
    title: "{actor} moved the pipeline stage {subject}",
    when: "the order of the leads board's stages changes",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "settings.stage_deleted": {
    subject: "settings",
    title: "{actor} deleted the pipeline stage {subject}",
    when: "an empty stage is removed from the leads board",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },

  // ── mailbox: where the firm's mail leaves from ─────────────────────────────
  //
  // Its own subject, split out of `mailouts` the way the gate was: sending a letter and rewriting
  // the credentials the firm's mail leaves from are not the same privilege, and one of these
  // accounts decides where invoices come from.
  "mailbox.created": {
    subject: "mailbox",
    title: "{actor} added the mailbox {subject}",
    when: "a sending account is configured",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    changeKeys: ["fromEmail"],
    enabledByDefault: true,
  },
  /** Never the password: §5.1's rule, and the one place it would be most tempting to break. */
  "mailbox.updated": {
    subject: "mailbox",
    title: "{actor} changed the mailbox {subject}",
    when: "a sending account's address, host or signature changes",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    changeKeys: ["name", "fromEmail", "fromName", "smtpHost", "smtpPort", "imapHost", "signature"],
    enabledByDefault: true,
  },
  "mailbox.deleted": {
    subject: "mailbox",
    title: "{actor} deleted the mailbox {subject}",
    when: "a sending account is removed",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    enabledByDefault: true,
  },
  "mailbox.default_changed": {
    subject: "mailbox",
    title: "{actor} made {subject} the default mailbox",
    when: "the account letters go from by default changes",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    enabledByDefault: true,
  },
  /** Whoever holds this account holds where the firm's invoices appear to come from. */
  "mailbox.invoice_sender_changed": {
    subject: "mailbox",
    title: "{actor} made {subject} the invoice sender",
    when: "the account invoices are sent from changes",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    enabledByDefault: true,
  },
  "mailbox.tested": {
    subject: "mailbox",
    title: "{actor} tested the mailbox {subject}",
    when: "somebody checks a sending account's connection or sends a test letter",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["ok", "detail"],
    enabledByDefault: true,
  },
  /**
   * The pair that says whether the firm can still hear its own mail coming back. Deduped by the
   * mailbox: the sweep runs every fifteen minutes, and a broken mailbox would otherwise write 96
   * rows a day.
   */
  "mailbox.read_failed": {
    subject: "mailbox",
    title: "{subject} stopped answering",
    when: "the delivery sweep cannot read a mailbox",
    granularity: "item",
    actorKinds: ["system"],
    retention: "ordinary",
    changeKeys: ["error"],
    dedupe: { key: "mailbox", windowMinutes: 720 },
    enabledByDefault: true,
  },
  "mailbox.read_recovered": {
    subject: "mailbox",
    title: "{subject} is answering again",
    when: "a mailbox that had stopped answering can be read again",
    granularity: "item",
    actorKinds: ["system"],
    retention: "ordinary",
    enabledByDefault: true,
  },

  // ── mailout and campaign: letters that left the building ───────────────────
  "mailout.sent": {
    subject: "mailout",
    title: "{actor} sent {subject}",
    when: "a letter or a mail-out is sent by a person",
    granularity: "summary",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["recipients", "kind"],
    enabledByDefault: true,
  },
  /**
   * Delivery runs after the response returns, so a restart leaves whatever it had not reached
   * reading as still in flight, for ever. The sweep that closes those out is the only thing that
   * ever says a send died — and until now it said it to a log nobody reads.
   */
  "mailout.send_abandoned": {
    subject: "mailout",
    title: "Interrupted letters were closed",
    when: "a send that died mid-flight is closed out as failed",
    granularity: "summary",
    actorKinds: ["system"],
    retention: "ordinary",
    changeKeys: ["closed"],
    enabledByDefault: true,
  },
  "mailout.template_created": {
    subject: "mailout",
    title: "{actor} added the letter template {subject}",
    when: "a letter template is created",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "mailout.template_updated": {
    subject: "mailout",
    title: "{actor} changed the letter template {subject}",
    when: "a letter template's subject, heading or body changes",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["name", "subject", "heading", "kind"],
    enabledByDefault: true,
  },
  "mailout.template_deleted": {
    subject: "mailout",
    title: "{actor} deleted the letter template {subject}",
    when: "a letter template is removed",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "campaign.created": {
    subject: "campaign",
    title: "{actor} created the campaign {subject}",
    when: "a scheduled series of letters is set up",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["rhythm", "startsOn", "recipients"],
    enabledByDefault: true,
  },
  "campaign.updated": {
    subject: "campaign",
    title: "{actor} changed the campaign {subject}",
    when: "a campaign's rhythm, dates, template or recipients change",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["rhythm", "startsOn", "endsOn", "sendAt", "templateId", "recipients"],
    enabledByDefault: true,
  },
  "campaign.started": {
    subject: "campaign",
    title: "{actor} started the campaign {subject}",
    when: "a campaign is switched on and begins firing on its dates",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "campaign.stopped": {
    subject: "campaign",
    title: "{actor} stopped the campaign {subject}",
    when: "a campaign is switched off and stops firing",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "campaign.deleted": {
    subject: "campaign",
    title: "{actor} deleted the campaign {subject}",
    when: "a campaign is removed",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  /**
   * A campaign that cannot fire stays due and the error goes to the log. This is the row that makes
   * "why did the newsletter not go out" answerable from the campaign rather than from a container.
   */
  "campaign.fire_failed": {
    subject: "campaign",
    title: "Campaign {subject} could not be sent",
    when: "a scheduled campaign's run throws — it stays due and is retried",
    granularity: "item",
    actorKinds: ["system"],
    retention: "ordinary",
    changeKeys: ["error", "period"],
    dedupe: { key: "campaign", windowMinutes: 720 },
    enabledByDefault: true,
  },

  // ── meeting: the firm's own time ───────────────────────────────────────────
  "meeting.created": {
    subject: "meeting",
    title: "{actor} booked {subject}",
    when: "a meeting is put in the calendar",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["startAt", "durationMinutes"],
    enabledByDefault: true,
  },
  "meeting.updated": {
    subject: "meeting",
    title: "{actor} changed {subject}",
    when: "a meeting's title, length, link or note changes",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["title", "durationMinutes", "link", "description", "remindMinutesBefore"],
    enabledByDefault: true,
  },
  /**
   * Its own key rather than a field of `meeting.updated`, for the same reason
   * `task.deadline_changed` is: a moved meeting reaches other people's days, and turning up to one
   * that moved is the failure the whole calendar module is built around.
   */
  "meeting.moved": {
    subject: "meeting",
    title: "{actor} moved {subject}",
    when: "a meeting's start time changes",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["startAt"],
    enabledByDefault: true,
  },
  "meeting.cancelled": {
    subject: "meeting",
    title: "{actor} called off {subject}",
    when: "a meeting is cancelled — reversibly, it stays one row",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "meeting.restored": {
    subject: "meeting",
    title: "{actor} put {subject} back on",
    when: "a cancelled meeting is restored",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "meeting.participants_changed": {
    subject: "meeting",
    title: "{actor} changed who is coming to {subject}",
    when: "people are added to or taken off a meeting",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["added", "removed"],
    enabledByDefault: true,
  },

  // ── settings: what the firm itself is, and what every form offers ──────────
  //
  // One subject, because that is what a person looking for it would guess — "somebody changed a
  // setting" is the question, and which screen it was on is the answer, not the question.
  "settings.firm_changed": {
    subject: "settings",
    title: "{actor} changed the firm's details",
    when: "the firm's name, requisites, address or clock change",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: [
      "name",
      "timezone",
      "address",
      "phone",
      "email",
      "taxId",
      "bankDetails",
      "notifySweepAt",
      "notifyDeadlineDays",
      "meetingRemindMinutes",
    ],
    enabledByDefault: true,
  },
  /**
   * Its own route and its own event. Invoice numbering is the one field in this product nothing can
   * repair after the fact — a counter moved backwards issues a number that already exists — which
   * is why it was split off the firm form in the first place (permissions.md §4).
   */
  "settings.numbering_changed": {
    subject: "settings",
    title: "{actor} changed invoice numbering",
    when: "the invoice prefix or counter width changes",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    changeKeys: ["invoicePrefix", "invoiceCounterDigits"],
    enabledByDefault: true,
  },
  "settings.logo_changed": {
    subject: "settings",
    title: "{actor} changed the firm's logo",
    when: "the logo every screen is stamped with is replaced",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "settings.mail_logo_changed": {
    subject: "settings",
    title: "{actor} changed the logo on letters",
    when: "the logo at the top of every letter the firm sends is replaced or removed",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  /**
   * The POSTAL address, read off the code rather than assumed from the event's name: CAN-SPAM
   * requires a physical address in every commercial letter, so this field is what decides whether
   * the firm may send one at all.
   */
  "settings.firm_mail_changed": {
    subject: "settings",
    title: "{actor} changed the firm's postal address for letters",
    when: "the address printed at the foot of every commercial letter changes",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["postalAddress"],
    enabledByDefault: true,
  },
  "settings.source_created": {
    subject: "settings",
    title: "{actor} added the source {subject}",
    when: "a new \"where did they come from\" option is added",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "settings.source_updated": {
    subject: "settings",
    title: "{actor} changed the source {subject}",
    when: "a source is renamed or deactivated",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["name", "active"],
    enabledByDefault: true,
  },
  "settings.source_deleted": {
    subject: "settings",
    title: "{actor} deleted the source {subject}",
    when: "a source nothing records is removed",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  /**
   * Only the DEFAULT, not a rename or a colour. The default is what every new task is given when
   * nobody chooses, so moving it changes work that has not been created yet — the rest of the
   * priority form is presentation.
   */
  "settings.priority_default_changed": {
    subject: "settings",
    title: "{actor} made {subject} the default priority",
    when: "the priority every new task starts at changes",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "settings.column_created": {
    subject: "settings",
    title: "{actor} added the board column {subject}",
    when: "a column is added to the task board",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "settings.column_updated": {
    subject: "settings",
    title: "{actor} renamed the board column {subject}",
    when: "a board column is renamed",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["name"],
    enabledByDefault: true,
  },
  /**
   * No diff: a column can only be deleted once it is EMPTY — the service refuses while cards are in
   * it — so there is nothing that moved, and declaring keys the code never writes would be a
   * registry entry describing an imagined service rather than this one.
   */
  "settings.column_deleted": {
    subject: "settings",
    title: "{actor} deleted the board column {subject}",
    when: "an empty board column is removed",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "settings.column_moved": {
    subject: "settings",
    title: "{actor} moved the board column {subject}",
    when: "the order of the board's columns changes",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  /**
   * **Who stopped us recording something.**
   *
   * The switch that decides what the log holds was itself the one piece of firm configuration
   * nothing recorded — turning off `file.downloaded` left a bare `PATCH /api/activity/policies/:action`
   * and no name against it. An audit trail whose own controls are outside the audit trail is the
   * gap this module exists to close, so it closes it on itself (audit, 2026-09-08).
   */
  "settings.activity_switched": {
    subject: "settings",
    title: "{actor} changed what is recorded: {subject}",
    when: "an event is switched on or off in Settings → Activity",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    changeKeys: ["enabled"],
    enabledByDefault: true,
  },
  "settings.notification_policy_changed": {
    subject: "settings",
    title: "{actor} changed the notification rule for {subject}",
    when: "the firm turns a notification on or off, or changes who gets it",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    /**
     * The fields `PATCH /api/notifications/policies/:trigger` can actually write. `roles` was
     * declared and had no producer — the input schema has never accepted it — while the three
     * `default*` switches, which decide what every colleague without a preference row receives,
     * were writable and undeclared (audit, 2026-09-09).
     */
    changeKeys: [
      "enabled",
      "inApp",
      "email",
      "sound",
      "defaultInApp",
      "defaultEmail",
      "defaultSound",
      "recipientGate",
      "customUserIds",
    ],
    enabledByDefault: true,
  },

  // ── service: the catalog the whole product bills from ──────────────────────
  "service.created": {
    subject: "service",
    title: "{actor} added the service {subject}",
    when: "a new service is added to the catalog",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["type", "defaultAmount"],
    enabledByDefault: true,
  },
  "service.updated": {
    subject: "service",
    title: "{actor} changed the service {subject}",
    when: "a service's name, price, billing rule or colour changes",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: [
      "name",
      "type",
      "defaultAmount",
      "invoiceTrigger",
      "invoiceDay",
      "dueDays",
      "color",
    ],
    enabledByDefault: true,
  },
  /**
   * The activation pair is split out of `service.updated` because it is the field with the reach:
   * an inactive service cannot be assigned, cannot be the default, and stops appearing in every
   * picker in the product.
   */
  "service.activated": {
    subject: "service",
    title: "{actor} activated the service {subject}",
    when: "a service is offered again",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "service.deactivated": {
    subject: "service",
    title: "{actor} deactivated the service {subject}",
    when: "a service stops being offered — it leaves every picker in the product",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  /** Hard delete, allowed only when no client ever used it. Otherwise it is deactivated. */
  "service.deleted": {
    subject: "service",
    title: "{actor} deleted the service {subject}",
    when: "a service with no history at all is removed from the catalog",
    granularity: "item",
    actorKinds: ["user"],
    retention: "long",
    changeKeys: ["type"],
    enabledByDefault: true,
  },
  "service.made_default": {
    subject: "service",
    title: "{actor} made {subject} the default for new clients",
    when: "the service every new client is given on create changes",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  "service.default_cleared": {
    subject: "service",
    title: "{actor} cleared {subject} as the default for new clients",
    when: "the firm stops giving every new client a service on create",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    enabledByDefault: true,
  },
  /**
   * A task template is what turns a service into recurring work, so adding or removing one changes
   * what the nightly sweep produces for every client who holds that service.
   */
  "service.template_added": {
    subject: "service",
    title: "{actor} added a task to the service {subject}",
    when: "a recurring task template is added to a service",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["template", "periodicity"],
    enabledByDefault: true,
  },
  "service.template_changed": {
    subject: "service",
    title: "{actor} changed a task of the service {subject}",
    when: "a task template's name, rhythm or assignees change",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["template"],
    enabledByDefault: true,
  },
  "service.template_removed": {
    subject: "service",
    title: "{actor} removed a task from the service {subject}",
    when: "a recurring task template is deleted — that work stops being generated",
    granularity: "item",
    actorKinds: ["user"],
    retention: "ordinary",
    changeKeys: ["template"],
    enabledByDefault: true,
  },

  // ── system: what the product did when nobody was watching ──────────────────
  "system.started": {
    subject: "system",
    title: "The application started on version {subject}",
    when: "the server boots",
    granularity: "item",
    actorKinds: ["system"],
    retention: "ordinary",
    changeKeys: ["version"],
    enabledByDefault: true,
  },
  /**
   * "Everything broke at 14:00" against "the deploy was at 13:58" — the question asked most often
   * after an incident, and today answered by hand against container logs the deploy has just
   * destroyed by replacing the container (§3.3).
   *
   * Detected rather than announced: the boot compares its own version to the last one recorded, so
   * no shell script has to write SQL (decided 2026-09-08).
   */
  "system.deployed": {
    subject: "system",
    title: "Deployed version {subject}",
    when: "the application boots on a version different from the last one recorded",
    granularity: "item",
    actorKinds: ["system"],
    retention: "long",
    changeKeys: ["version", "previous", "by"],
    enabledByDefault: true,
  },
  /**
   * The most destructive operation in the product — it empties the client book — and today the
   * application learns nothing about it. Recorded BEFORE the SQL runs, which is also why the table
   * is on the `--reset` keep-list: a reset that erased the record of the reset would be the one gap
   * nobody could close afterwards (§3.3, §11).
   */
  "system.data_reset": {
    subject: "system",
    title: "Client data was reset by {subject}",
    when: "`./scripts/deploy.sh --reset` runs, before it wipes anything",
    granularity: "item",
    actorKinds: ["system"],
    retention: "long",
    changeKeys: ["by", "host"],
    enabledByDefault: true,
  },
  /**
   * A night did not happen. One row linking to the `JobEvent` that holds the detail — the
   * specialised journal keeps the detail, this log records only what a person searches for across
   * everything (§9). Deduped because a job failing every fifteen minutes writes 96 rows a day and
   * buries everything else (§4.2).
   */
  "system.job_failed": {
    subject: "system",
    title: "{subject} failed",
    when: "a scheduled job throws",
    granularity: "item",
    actorKinds: ["system"],
    retention: "ordinary",
    changeKeys: ["job", "error", "streak"],
    journal: "job_event",
    dedupe: { key: "job", windowMinutes: 60 },
    enabledByDefault: true,
  },
  /**
   * **Somebody pointed a development tool at production, on purpose.**
   *
   * `scripts/dev/guard.ts` refuses to run on `NODE_ENV=production` unless
   * `I_KNOW_THIS_IS_PRODUCTION=yes` is set — a door that exists because a guard with no way past it
   * gets deleted by whoever first needs past it. These scripts create fake data and delete real
   * rows; `seed-notifications.ts` empties every colleague's bell. Going through that door
   * deliberately is exactly the kind of act a log is for.
   */
  "system.dev_script_forced": {
    subject: "system",
    title: "A development script was run against production: {subject}",
    when: "somebody sets I_KNOW_THIS_IS_PRODUCTION=yes and runs a script from scripts/dev",
    granularity: "item",
    actorKinds: ["system"],
    retention: "long",
    changeKeys: ["script"],
    enabledByDefault: true,
  },
  /**
   * **The tier-1 fallback, and the only key no service ever passes.**
   *
   * The hook writes it when a mutating request finished and nothing enriched it — which is what
   * makes "wide" true on the day a route ships rather than on the day somebody remembers it. Where
   * a service DID say what happened, this row is not written at all: an enriched gesture already
   * carries the actor, the IP and the route on its own rows, and a bare `PATCH /api/clients/…`
   * beside "Olena changed Petrenko's phone" is noise in the one screen built to avoid it.
   */
  "system.request": {
    subject: "system",
    title: "{actor} sent {subject}",
    when: "any mutating request that no service described in its own words",
    granularity: "item",
    actorKinds: ["user", "client", "system"],
    retention: "ordinary",
    enabledByDefault: true,
  },
} satisfies Record<string, ActivityEventSpec>;

export type ActivityKey = keyof typeof EVENTS;

/**
 * Read as `ActivityEventSpec` rather than as its own literal type — `satisfies` above keeps the
 * KEYS exact (that is what `ActivityKey` is) while this keeps every optional field visible to a
 * reader that does not know which event it holds. The same arrangement `shared/access.ts` uses.
 */
export const ACTIVITY_EVENTS: Record<ActivityKey, ActivityEventSpec> = EVENTS;

export const ACTIVITY_KEYS = Object.keys(ACTIVITY_EVENTS) as ActivityKey[];

/**
 * **Empty, as of 2026-09-08 — the pass is finished.**
 *
 * It was the enrichment checklist: a key sat here until its service was opened, because that is
 * when its `changeKeys` stop being a guess. Kept rather than deleted, because it is the shape the
 * next module uses — its events are named here first and move into the registry when they are
 * wired, with `server/activity.producers.test.ts` failing in both directions meanwhile.
 */
export const PLANNED_EVENT_KEYS: readonly string[] = [];

// ── helpers ──────────────────────────────────────────────────────────────────

export function isActivityKey(value: string): value is ActivityKey {
  return Object.prototype.hasOwnProperty.call(ACTIVITY_EVENTS, value);
}

export function groupOf(key: ActivityKey): ActivityGroup {
  return SUBJECT_GROUP[ACTIVITY_EVENTS[key].subject];
}

/**
 * The two keys the tier-1 hook writes itself. Exported so the hook cannot drift from the registry
 * and so a test can assert both are declared.
 */
export const TIER1_REQUEST = "system.request" satisfies ActivityKey;
export const TIER1_REFUSED = "session.gate_refused" satisfies ActivityKey;

/**
 * The row's sentence, in the firm's language.
 *
 * Lives here rather than in the screen because BOTH ends need it: the activity screen and the
 * client card's tab render the same rows, and a sentence written twice is a sentence that will
 * eventually read two ways. An absent label becomes an em dash rather than an empty gap — some
 * events genuinely have no subject (`secret.vault_unlocked` is about a client, not a thing).
 */
export function renderTitle(
  key: ActivityKey,
  row: { actorLabel?: string | null; subjectLabel?: string | null; clientLabel?: string | null },
): string {
  /**
   * `{subject}` falls back to the CLIENT before it falls back to an em dash.
   *
   * A handful of acts are about a client without naming a thing of their own — unsubscribing them
   * from mail, unlocking their vault — and those rendered as "changed whether — receives mail".
   * The row already carries whose it was; this is one place rather than a label argued into every
   * such call site (found by scanning every record() call, 2026-09-08).
   */
  const subject = row.subjectLabel?.trim() || row.clientLabel?.trim() || "—";
  return ACTIVITY_EVENTS[key].title
    .replace("{actor}", row.actorLabel?.trim() || "Somebody")
    .replace("{subject}", subject);
}

/** Which events survive the two-year purge — §11's four classes, declared per event. */
export function retentionYears(key: ActivityKey): 2 | 7 {
  return ACTIVITY_EVENTS[key].retention === "long" ? 7 : 2;
}

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  ACTIVITY_EVENTS,
  ACTIVITY_KEYS,
  isActivityKey,
  retentionYears,
  TIER1_REFUSED,
  TIER1_REQUEST,
  type ActivityKey,
  type ActivityOutcome,
  type ActorKind,
} from "@shared/activity.js";
import { prisma } from "./db.js";
import { isTest } from "./config.js";
import { personName } from "./names.js";

/**
 * **Recording an act, in one place.**
 *
 * Clients, Tasks, Payments, Mailouts, Access and Users all record, and the module graph is a DAG —
 * none of them may import another (eslint.config.js enforces it), so this cannot live in any of
 * them. The same problem `core/notify.ts` and `core/system-tasks.ts` already solved, and the same
 * answer.
 *
 * ## Why `AsyncLocalStorage`, which this codebase had none of before
 *
 * The layering rule is that a service never touches `request`/`reply`. But an event needs the
 * correlation id, the actor and the IP, all of which are facts about the REQUEST. The alternative
 * was threading a context parameter through some forty service functions that already take
 * `actor: User` — and being forgotten in the forty-first, silently, with no test able to see it.
 * So the request hook opens a store and `record()` reads it. A service still takes no request
 * object and still cannot reach one (activity-log.md §7).
 *
 * ## Buffer, then flush — which is what makes the table INSERT-only
 *
 * `record()` does not write. It appends to the store, and `flush()` inserts everything at
 * `onResponse`. Three properties fall out of that, and each was a decision (2026-09-08):
 *
 *   1. **Always after the transaction commits.** A log entry for a write that rolled back is worse
 *      than no entry, and this cannot be got wrong by a caller, because the write happens after the
 *      handler has returned. The rule `notify()` follows by convention, this one follows by
 *      construction — and it is the mistake `TimeEntryAuditLog` makes today, writing as a second
 *      statement outside any transaction (`permissions.md` §20.2).
 *   2. **`outcome` is known.** At `onRequest` it is not: a gate refusal, a validation error and a
 *      success are indistinguishable before the handler runs.
 *   3. **No `UPDATE` anywhere.** The spec's first draft had the hook open a row and enrichment
 *      write into it, which cannot coexist with narrowing the app's database role to
 *      `INSERT, SELECT` on this table (§10 against §2). Buffering resolves it: one insert, one
 *      shape, no row ever revisited.
 *
 * The cost, stated rather than discovered: a process killed between the commit and the response
 * loses that request's rows. That is the same bargain `notify()` already makes, and the alternative
 * — a row written before the outcome is known — trades a rare loss for a permanent lie.
 *
 * ## Recording never fails a request
 *
 * Everything here is logged and swallowed. A failure to log is a failure to log; it is not a
 * failure to bill, to send, or to save.
 */

// ── the store ────────────────────────────────────────────────────────────────

export interface ActivityActor {
  kind: ActorKind;
  userId?: string | null;
  clientId?: string | null;
  /** snapshotted, so a deleted actor still reads. Never empty. */
  label: string;
}

/** What a service says about what it did. Everything else comes from the store. */
export interface RecordDetails {
  subjectId?: string | null;
  /** snapshotted — "Petrenko", "INV-2026-041". The screen renders this, not a join. */
  subjectLabel?: string | null;
  /** the client this concerns, when there is one — the client card's Activity tab reads it (§5) */
  clientId?: string | null;
  /** ONLY the fields that moved. Build it with `diff()`; an empty diff writes nothing. */
  changes?: Record<string, unknown> | null;
  /** overrides the store's actor — for an act the scheduler performs inside a person's request */
  actor?: ActivityActor;
  /** for a `dedupe` event: the value its window is keyed by (a job name, a mailout id) */
  dedupeValue?: string | null;
  /**
   * **Overrides the context's outcome, for an event that knows better than the request does.**
   *
   * `outcome` is otherwise a fact about the REQUEST — a gate refused it, or the app threw. That is
   * the right default and it is wrong for exactly one shape: a background job whose own `catch`
   * records the failure. The job did not fail as a request; there is no request. It failed as the
   * thing it was, and `runWithActivity`'s flush was hard-coding `ok` over the top of every
   * `*_failed` event the scheduler, the bounce sweep and the campaign sweep produce — so the one
   * column the screen uses to mark a problem said there was none (audit, 2026-09-08).
   */
  outcome?: ActivityOutcome;
}

interface PendingEvent extends RecordDetails {
  action: ActivityKey;
}

declare module "fastify" {
  interface FastifyRequest {
    /**
     * The request's own activity context, held on the request rather than read back out of
     * `AsyncLocalStorage` at flush time. `onResponse` runs after the reply has been written and is
     * not guaranteed to be in the same async execution context the handler ran in; a store read
     * from ALS there can be the wrong one or none. The request object is the one thing certain to
     * be this request's.
     */
    activity?: ActivityStore;
  }
}

export interface ActivityStore {
  correlationId: string;
  actor: ActivityActor;
  ip?: string | null;
  userAgent?: string | null;
  gate?: string | null;
  method?: string | null;
  route?: string | null;
  events: PendingEvent[];
  /** set by the error handler, read at flush — `module_closed`, `admin_only`, … */
  refusalCode?: string | null;
  /**
   * **This context speaks for itself: item events inside it are dropped.**
   *
   * For the bulk scripts. `scripts/import-clients.ts` calls `createClient` 177 times and each call
   * records `client.created`, but activity-log.md §3.3 is explicit that an import records "one
   * event with a count and the source file, not a row per client" — 177 rows would bury a year of
   * ordinary work in one afternoon.
   *
   * Declared as a property of the CONTEXT rather than checked inside `createClient`, because the
   * service is right to record what it did and it is the caller that knows this is a bulk run. The
   * filter is by `granularity`, so a summary the script writes itself still lands.
   */
  summaryOnly?: boolean;
  /** a request that recorded nothing still gets its tier-1 row; one that did, does not */
  flushed: boolean;
}

const storage = new AsyncLocalStorage<ActivityStore>();

/** The system actor every job, script and boot-time write shares unless it names itself. */
export const SYSTEM_ACTOR: ActivityActor = { kind: "system", label: "The system" };

export function currentActivityStore(): ActivityStore | undefined {
  return storage.getStore();
}

function newStore(seed: Partial<ActivityStore> = {}): ActivityStore {
  return {
    correlationId: seed.correlationId ?? randomUUID(),
    actor: seed.actor ?? SYSTEM_ACTOR,
    ip: seed.ip ?? null,
    userAgent: seed.userAgent ?? null,
    gate: seed.gate ?? null,
    method: seed.method ?? null,
    route: seed.route ?? null,
    events: [],
    flushed: false,
    summaryOnly: seed.summaryOnly ?? false,
  };
}

/**
 * Open a context for the CURRENT request and everything it goes on to await.
 *
 * `enterWith` rather than `run`: a Fastify `onRequest` hook returns before the handler runs, so a
 * store opened with `run` would be gone by the time any service called `record()`. `enterWith`
 * binds it to the request's async resource, which is what every request-context plugin for this
 * framework does. The store is also handed back and kept on the request, because the flush happens
 * in `onResponse` and that is past where ALS can be relied on.
 */
export function enterActivityContext(seed: Partial<ActivityStore>): ActivityStore {
  const store = newStore(seed);
  storage.enterWith(store);
  return store;
}

/**
 * Open a context. The request hook calls it for every request; the scheduler, the import scripts
 * and `ensureBootstrapAdmin` call it for work that has no request at all — which is the half a
 * request-level hook cannot see (§3.3).
 */
export function runWithActivity<T>(
  seed: Partial<Omit<ActivityStore, "events" | "flushed">> & { actor?: ActivityActor },
  fn: () => Promise<T>,
): Promise<T> {
  const store = newStore(seed);
  return storage.run(store, async () => {
    try {
      return await fn();
    } finally {
      // A job or a script has no `onResponse` to flush it, so the wrapper flushes its own.
      await flushStore(store, { outcome: "ok", tier1: false });
    }
  });
}

/** The actor is resolved by the access hook, after the store is already open. */
export function setActivityActor(actor: ActivityActor) {
  const store = storage.getStore();
  if (store) store.actor = actor;
}

/**
 * The error handler names the refusal; the flush writes it beside the outcome. Takes the store
 * explicitly because the error handler is the one place that always has the request in hand.
 */
export function setActivityRefusal(code: string, store?: ActivityStore) {
  const target = store ?? storage.getStore();
  if (target) target.refusalCode = code;
}

export function actorFromUser(
  user: { id: string; firstName: string | null; lastName: string | null } | null | undefined,
): ActivityActor {
  return user
    ? { kind: "user", userId: user.id, label: personName(user) }
    : { kind: "system", label: "Anonymous" };
}

// ── recording ────────────────────────────────────────────────────────────────

/**
 * **What actually happened, in the firm's language.**
 *
 * Called from a SERVICE, after its repository's transaction has returned — never from inside one,
 * and never from a repository. The service is where the actor and the meaning live; the repository
 * is where the transaction lives, and those are deliberately different places.
 */
export function record(action: ActivityKey, details: RecordDetails = {}) {
  const spec = ACTIVITY_EVENTS[action];
  if (!spec) {
    fail(`unknown activity key: ${action}`);
    return;
  }
  const changes = validateChanges(action, details.changes ?? null);
  /**
   * **No enriched event is written when the diff is empty** (§4.2). Six sites would otherwise fire
   * on presence rather than on change — a client save carrying only `{companies}` still reaches
   * `updateClient`, and company reconciliation writes an update row for every kept company whether
   * or not a field moved. Tier 1 still records the request.
   */
  if (spec.changeKeys && changes === null) return;

  const store = storage.getStore();

  /**
   * **Buffering is the normal path; writing straight through is the other two.**
   *
   * No store at all — a script that forgot to wrap itself, or a stray call in a test. Write it
   * rather than drop it: a recorded act with a lonely correlation id beats a lost one.
   *
   * A store that is ALREADY FLUSHED is the case that matters, and it is not hypothetical. Mail-out
   * delivery runs after the response returns on purpose (a hundred SMTP round-trips cannot live
   * inside a request), so the flush has happened by the time the run knows it failed. Appending to
   * that store would put the event in a list nothing will ever insert — a silent loss, found
   * 2026-09-08 while wiring `mailout.send_failed`. The correlation id is KEPT, so the late row
   * still joins the gesture that started it on the screen.
   */
  if (!store || store.flushed) {
    void writeEvents(
      {
        ...store,
        correlationId: store?.correlationId ?? randomUUID(),
        actor: details.actor ?? store?.actor ?? SYSTEM_ACTOR,
        events: [{ ...details, action, changes }],
        flushed: true,
      },
      "ok",
    );
    return;
  }
  store.events.push({ ...details, action, changes });
}

/**
 * `changes` may hold exactly the keys the registry declares, and nothing where it declares none.
 *
 * Declared, this is testable in one loop; undeclared it is testable only by reading every service
 * (§4.3). Returns null for an empty or absent diff, which is what suppresses the event.
 */
function validateChanges(
  action: ActivityKey,
  changes: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!changes) return null;
  const keys = Object.keys(changes);
  if (keys.length === 0) return null;
  const allowed = ACTIVITY_EVENTS[action].changeKeys;
  if (!allowed) {
    fail(`${action} declares no changeKeys but was given ${keys.join(", ")}`);
    return null;
  }
  const stray = keys.filter((k) => !allowed.includes(k));
  if (stray.length > 0) {
    fail(`${action} may not carry ${stray.join(", ")} — declared: ${allowed.join(", ")}`);
    for (const k of stray) delete changes[k];
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

/**
 * Loud where a person can fix it, silent where a person is waiting.
 *
 * A registry mistake is a programming error and the suite must fail on it; in production the same
 * mistake must not cost the request that carried it (§7: recording never fails a request).
 */
function fail(message: string) {
  if (isTest) throw new Error(`activity: ${message}`);
  console.error(`activity: ${message}`);
}

/**
 * Only the fields that moved — `{ phone: { from, to } }`, never the whole record (§5.1).
 *
 * One helper rather than forty hand-written comparisons, which is also what makes "the log is an
 * index of events, not a shadow database" a property of the code rather than of everybody's care.
 */
export function diff<T extends Record<string, unknown>>(
  before: T | null | undefined,
  after: Partial<T> | null | undefined,
  keys: readonly (keyof T & string)[],
): Record<string, { from: unknown; to: unknown }> | null {
  if (!after) return null;
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of keys) {
    if (!(key in after)) continue; // not part of this write at all
    const from = before ? before[key] : undefined;
    const to = after[key];
    if (same(from, to)) continue;
    out[key] = { from: normalise(from), to: normalise(to) };
  }
  return Object.keys(out).length > 0 ? out : null;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date || b instanceof Date) return normalise(a) === normalise(b);
  // null and undefined both mean "no value" to a person reading a diff
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  return false;
}

/**
 * **A diff value is capped at 200 characters.**
 *
 * §5.1 keeps the log an index of events rather than a shadow database, and a `description` field is
 * a paragraph: without this, one client save writes two paragraphs into a table that is read by a
 * screen, indexed five ways and kept for two years. Found on screen the first time a real edit was
 * made through it (2026-09-08) — the row was three lines of somebody's notes.
 *
 * The precedent is `recordJobRun`, which caps its error text for the same reason. What is lost is
 * the tail of a long value; what is kept is that the field moved and roughly how — which is what a
 * log is for. The record itself still holds the whole thing.
 */
const MAX_VALUE = 200;

function normalise(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (v === undefined) return null;
  if (typeof v === "string" && v.length > MAX_VALUE) return `${v.slice(0, MAX_VALUE)}…`;
  return v;
}

// ── the policy: whether an event is recorded at all ──────────────────────────

/**
 * Read on every flush, so it is read from memory. A row per registry key is 138 booleans — smaller
 * than a single client — and the TTL is the same belt-and-braces `core/access.ts` uses for the
 * same reason. Disabled outright under test so a suite that flips a policy sees it immediately.
 */
const POLICY_TTL_MS = isTest ? 0 : 30_000;
let policy: { disabled: Set<string>; loadedAt: number } | null = null;

export function invalidateActivityPolicy() {
  policy = null;
}

async function disabledActions(): Promise<Set<string>> {
  if (policy && Date.now() - policy.loadedAt < POLICY_TTL_MS) return policy.disabled;
  const rows = await prisma.activityPolicy.findMany({
    where: { enabled: false },
    select: { action: true },
  });
  policy = { disabled: new Set(rows.map((r) => r.action)), loadedAt: Date.now() };
  return policy.disabled;
}

// ── the flush ────────────────────────────────────────────────────────────────

export interface FlushOptions {
  outcome: ActivityOutcome;
  /**
   * Write the bare tier-1 row when nothing enriched this request. False for jobs and scripts:
   * `system.request` describes an HTTP request and there is none.
   */
  tier1: boolean;
  statusCode?: number;
}

/**
 * Insert everything this context buffered. Called once per request from `onResponse`, and once per
 * job or script by `runWithActivity`'s own `finally`.
 */
export async function flushStore(
  store: ActivityStore | undefined,
  options: FlushOptions,
): Promise<number> {
  if (!store || store.flushed) return 0;
  store.flushed = true;
  return writeEvents(store, options.outcome, options);
}

/** The ALS-based flush, for a caller that has no store in hand. */
export async function flushActivity(options: FlushOptions): Promise<number> {
  return flushStore(storage.getStore(), options);
}

async function writeEvents(
  store: Pick<
    ActivityStore,
    "correlationId" | "actor" | "events" | "flushed" | "ip" | "userAgent" | "gate" | "method" | "route" | "refusalCode"
  > & Partial<ActivityStore>,
  outcome: ActivityOutcome,
  options?: FlushOptions,
): Promise<number> {
  try {
    let pending = store.events;

    /**
     * The tier-1 row, and the one case it is NOT written.
     *
     * A request nothing described gets `system.request` — that is what makes "every mutating route
     * is logged" true on the day a route ships. A request a service DID describe does not, because
     * its rows already carry the actor, the IP and the route, and a bare `PATCH /api/clients/…`
     * beside "Olena changed Petrenko's phone" is noise in the one screen built to avoid it.
     *
     * A GATE refusal is the exception to the exception: it is recorded as `session.gate_refused`
     * whatever else happened, because the permissions module keeps no record of what it decided
     * (`permissions.md` §20.3) and a refused request rarely reaches a service at all.
     *
     * 403 and not merely `outcome: refused`, which also covers 401. Being unauthenticated is not a
     * gate saying no — it is nobody having asked yet — and filing it under `session.gate_refused`
     * would put a signed-out browser's stray poll in the same list as "somebody was refused access
     * to Billing", which is the list's whole reason for existing.
     */
    if (options?.tier1) {
      if (options.statusCode === 403) {
        pending = [...pending, { action: TIER1_REFUSED, subjectLabel: store.route ?? null }];
      } else if (pending.length === 0) {
        pending = [{ action: TIER1_REQUEST, subjectLabel: store.route ?? null }];
      }
    }
    if (pending.length === 0) return 0;

    const disabled = await disabledActions();
    const rows = [];
    for (const event of pending) {
      if (disabled.has(event.action)) continue;
      // a bulk run writes its own summary; the per-item rows its services produced are dropped
      if (store.summaryOnly && ACTIVITY_EVENTS[event.action].granularity === "item") continue;
      if (await deduped(event)) continue;
      const actor = event.actor ?? store.actor;
      rows.push({
        actorKind: actor.kind,
        actorUserId: actor.userId ?? null,
        actorClientId: actor.clientId ?? null,
        actorLabel: actor.label,
        action: event.action,
        subject: ACTIVITY_EVENTS[event.action].subject,
        subjectId: event.subjectId ?? null,
        subjectLabel: event.subjectLabel ?? null,
        clientId: event.clientId ?? null,
        changes: (event.changes ?? undefined) as never,
        ip: store.ip ?? null,
        userAgent: store.userAgent ?? null,
        gate: store.gate ?? null,
        method: store.method ?? null,
        route: store.route ?? null,
        outcome: event.outcome ?? outcome,
        refusalCode: store.refusalCode ?? null,
        correlationId: store.correlationId,
      });
    }
    if (rows.length === 0) return 0;
    await prisma.activityEvent.createMany({ data: rows });
    return rows.length;
  } catch (error) {
    // §7: a failure to log is logged and swallowed. It is not a failure to save, bill or send.
    console.error("activity: could not record", error);
    return 0;
  }
}

/**
 * **A repeating failure writes one row per window, not 96 a day** (§4.2).
 *
 * Skipped rather than counted: keeping a running count would mean revisiting the row, and this
 * table is never UPDATEd — that is what lets its database role be narrowed to `INSERT, SELECT`
 * (§10). The count of attempts inside the window lives where it already lives: `JobHealth.failStreak`
 * for jobs, the specialised journal for the rest. Recorded here 2026-09-08 as a deviation from §4.2's
 * "with a count", taken deliberately in favour of §10.
 */
async function deduped(event: PendingEvent): Promise<boolean> {
  const rule = ACTIVITY_EVENTS[event.action].dedupe;
  if (!rule) return false;
  const since = new Date(Date.now() - rule.windowMinutes * 60_000);
  const existing = await prisma.activityEvent.findFirst({
    where: {
      action: event.action,
      occurredAt: { gte: since },
      ...(event.dedupeValue ? { subjectLabel: event.dedupeValue } : {}),
    },
    select: { id: true },
  });
  return existing !== null;
}

export { isActivityKey };

// ── retention ────────────────────────────────────────────────────────────────

/**
 * **The log outlives what it describes** (activity-log.md §11).
 *
 * It is the evidence that disposal happened, so purging it on the same clock as the client data
 * would destroy the proof at the moment it is needed. Two classes, declared per event rather than
 * listed here — a second hard-coded list would drift from the registry the first time somebody
 * added a key:
 *
 *   • ordinary — two years, matching (c)(6)'s disposal horizon;
 *   • long — seven, for sign-ins, role and access changes, and the disposal records themselves.
 *
 * An action no longer in the registry is purged as ordinary. That is deliberate: a key that was
 * removed is a key nothing writes any more, and holding its rows for seven years on the strength of
 * a spec that no longer exists would be keeping data because nobody decided to stop.
 *
 * **The run is recorded by `JobEvent`, not here.** §11 asks the purge to leave a trace, and §3.3
 * forbids `system.job_ran` because `JobEvent` already writes every run that did something, with a
 * better note than this module could compose. Both are satisfied by the scheduler's own journal:
 * `recordJobRun` writes the count, the System tab reads it, and the activity log stays out of a
 * subject it would only duplicate.
 *
 * **On the day the app's database role is narrowed to `INSERT, SELECT`** (§10, §16 q4) this is the
 * one function that stops working, and the whole change is to give it a connection with `DELETE` —
 * a maintenance `DATABASE_URL` and a second client here. Everything else in this module already
 * only inserts and selects.
 */
export async function purgeOldActivity(now: Date = new Date()): Promise<{ purged: number }> {
  const cutoff = (years: number) => {
    const d = new Date(now);
    d.setFullYear(d.getFullYear() - years);
    return d;
  };
  // `retentionYears` is the registry's own answer; asking it rather than re-deriving the rule is
  // what stops the purge and the screen drifting apart
  const longKeys = ACTIVITY_KEYS.filter((k) => retentionYears(k) === 7);
  const expired = {
    OR: [
      { action: { notIn: longKeys }, occurredAt: { lt: cutoff(2) } },
      { action: { in: longKeys }, occurredAt: { lt: cutoff(7) } },
    ],
  };

  /**
   * **Batched, for the run that has not run in months.**
   *
   * In steady state this is one batch of a few hundred rows and the loop turns once — a non-event.
   * The shape is for the other case: a job that was down through a broken deploy comes back and
   * tries to delete two years of backlog in ONE transaction, holding every row lock until it
   * commits and holding the whole database's xmin horizon back with it, which delays vacuum on
   * every other table too. Five thousand at a time costs nothing when there is nothing to do and
   * bounds the damage when there is.
   */
  const BATCH = 5_000;
  let purged = 0;
  for (;;) {
    const doomed = await prisma.activityEvent.findMany({
      where: expired,
      select: { id: true },
      take: BATCH,
    });
    if (doomed.length === 0) break;
    const { count } = await prisma.activityEvent.deleteMany({
      where: { id: { in: doomed.map((r) => r.id) } },
    });
    purged += count;
    if (doomed.length < BATCH) break;
  }
  return { purged };
}

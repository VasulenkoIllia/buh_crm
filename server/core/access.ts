import type { FastifyReply, FastifyRequest } from "fastify";
import type { User } from "../generated/prisma/client.js";
import type { UserRole } from "@shared/schema/enums.js";
import {
  allowsMethod,
  defaultAccessMap,
  GATES,
  GATE_KEYS,
  withDerivedGates,
  type AccessMap,
  type AccessState,
  type GateKey,
} from "@shared/access.js";
import { GATE_COPY } from "@shared/access-copy.js";
import { prisma } from "./db.js";
import { isTest } from "./config.js";
import { AppError, UnauthorizedError } from "./errors.js";
import { resolveUser } from "./auth.js";

/**
 * **Every route under `/api` declares what it is, and one hook enforces the answer.**
 *
 * Four declarations, and a route with none makes `buildApp()` throw — not a lint warning, not a
 * test somebody can skip: the server does not start. That is what makes "a new route is closed by
 * default" true, and it is the inverse of what this replaced, where a new route in
 * `tasks.routes.ts` was PUBLIC unless the author remembered a guard.
 */

export type RouteAccess =
  | {
      kind: "gate";
      gate: GateKey;
      /**
       * Ships inert with the value `"*"` on every route (stage 1). It exists now because adding a
       * column to `AccessPolicy`'s composite primary key later is the one stage-2 change that
       * would not be additive.
       */
      action: string;
      /**
       * A rule three states cannot express: admin-only INSIDE an otherwise open gate.
       *
       * Sixteen routes need it — editing or cancelling an invoice, editing or deleting a payment
       * and its audit trail (Billing must stay open, or nobody could bill), the four routes that
       * shape the leads pipeline, and the four that shape the task board plus the three time-entry
       * routes. Every one is a per-ACTION rule, which is §14's stage 2. Carrying them here rather
       * than leaving `requireAdmin` scattered in the route files keeps §6 true — the hook is still
       * the only place access is decided — and turns each into a row with a real `action` value on
       * the day stage 2 lands.
       */
      adminOnly: boolean;
    }
  | { kind: "shared" }
  | { kind: "own" }
  | { kind: "anonymous" };

export interface RouteAccessConfig {
  access: RouteAccess;
}

/** Belongs to a gate. The hook decides by the caller's state and by the request method. */
export function gate(unit: GateKey, opts: { adminOnly?: boolean } = {}): RouteAccessConfig {
  return { access: { kind: "gate", gate: unit, action: "*", adminOnly: opts.adminOnly === true } };
}

/**
 * Reference data — any authenticated user, whatever is closed.
 *
 * The rule for a new endpoint: if a screen that is NOT yours needs it to render, it is `shared`.
 * If only your own screen needs it, it is `gate`. When in doubt it is `gate` — a `shared` read is
 * open to the whole firm for ever.
 */
export function shared(): RouteAccessConfig {
  return { access: { kind: "shared" } };
}

/**
 * Acts only on the caller's own row — their profile, their timer, their tray.
 *
 * Separate from `shared` deliberately: stage 2 treats them differently, and the split costs one
 * helper today. It is also what stops an admin-only Team gate from locking every user out of
 * their own password.
 */
export function own(): RouteAccessConfig {
  return { access: { kind: "own" } };
}

/** Deliberately public: sign-in, the token links, the unsubscribe pages, `/health`. */
export function anonymous(): RouteAccessConfig {
  return { access: { kind: "anonymous" } };
}

/**
 * A closed area is not a generic 403.
 *
 * The SPA has to tell it apart from the Origin-check refusal and from an ownership refusal, and
 * stage 2 needs to tell it apart from an action refusal. A person whose area was closed
 * mid-session must read "this area was closed", never "something went wrong".
 */
/**
 * **A role refusal is not an ownership refusal, and neither is a closed area.**
 *
 * Three different 403s reach the SPA and they mean three different things to the person reading
 * them: "this area is shut for you" (`module_closed`), "this particular action is an admin's"
 * (`admin_only`), and "this record is not yours" (`forbidden`, thrown by the service that owns the
 * rule). The Origin check adds a fourth, also `forbidden`.
 *
 * `admin_only` was split out on 2026-09-07, during the audit, on evidence rather than principle:
 * the access matrix could not tell a hook refusal apart from the secrets vault saying "enter your
 * password first", and if a test cannot, neither can a screen. It is also the shape stage 2 needs
 * — a per-action refusal is this refusal with a name — so the contract does not have to move again
 * when that lands.
 */
export class AdminOnlyError extends AppError {
  constructor(gateKey: GateKey) {
    super(403, "admin_only", "Only an admin can do this", { gate: gateKey });
  }
}

export class ModuleClosedError extends AppError {
  constructor(
    public readonly gateKey: GateKey,
    readOnly: boolean,
  ) {
    super(
      403,
      "module_closed",
      readOnly
        ? `${GATE_COPY[gateKey].label} is open to you for reading only`
        : `${GATE_COPY[gateKey].label} is closed for your account`,
      { gate: gateKey, state: readOnly ? "read_only" : "closed" },
    );
  }
}

// ── resolving a person's answer ──────────────────────────────────────────────

interface AccessTables {
  /** `${gate}` → role → state */
  policies: Map<string, AccessState>;
  /** `${userId}:${gate}` → state */
  overrides: Map<string, AccessState>;
  loadedAt: number;
}

/**
 * Read on every request, so it is read from memory.
 *
 * Thirteen switchable gates times two roles is twenty-six rows, and overrides are sparse by design
 * — ten people would be at most 130 — so the whole of both tables is smaller than a single client.
 * Writes invalidate it directly; the TTL is belt-and-braces for anything that changes a row outside
 * the access routes. In tests the cache is disabled outright: a suite that seeds a policy and
 * immediately calls the route must see it.
 *
 * **The bound this puts on the design, stated so nobody has to discover it.** Invalidation is
 * IN-PROCESS. There is exactly one app container (the same assumption `secrets.service.ts` records
 * for its grant map), so today a change is live on the next request. The day this app runs two
 * containers, a change made on one takes up to `CACHE_TTL_MS` to be obeyed by the other — thirty
 * seconds of a person keeping access somebody just took away. That is a deliberate ceiling rather
 * than an oversight: dropping the TTL to zero costs two queries on every request, and the fix when
 * it is needed is a notification channel (Postgres `LISTEN/NOTIFY` on the two tables), not a
 * shorter timer.
 */
const CACHE_TTL_MS = isTest ? 0 : 30_000;
let tables: AccessTables | null = null;

export function invalidateAccessCache() {
  tables = null;
}

async function loadTables(): Promise<AccessTables> {
  if (tables && Date.now() - tables.loadedAt < CACHE_TTL_MS) return tables;
  /**
   * **`action: "*"` only, and that filter is load-bearing rather than tidy.**
   *
   * The column ships inert — carried so stage 2's per-action rules need no migration — but "inert"
   * has to be true in the reader, not just in the intention. Without this the map is keyed by
   * `gate:role` alone, so the first row stage 2 ever writes (`billing/user/invoice.cancel = closed`)
   * would collide with the gate's own row and, depending on which came back last, silently close
   * Billing for everybody. Found by `access-matrix.test.ts` on 2026-09-07, before it could happen.
   */
  const [policyRows, overrideRows] = await Promise.all([
    prisma.accessPolicy.findMany({ where: { action: "*" } }),
    prisma.accessOverride.findMany({ where: { action: "*" } }),
  ]);
  tables = {
    policies: new Map(policyRows.map((r) => [`${r.gate}:${r.role}`, r.state as AccessState])),
    overrides: new Map(
      overrideRows.map((r) => [`${r.userId}:${r.gate}`, r.state as AccessState]),
    ),
    loadedAt: Date.now(),
  };
  return tables;
}

/**
 * An ABSENT policy row means "the registry default", not "closed".
 *
 * A gate added to the registry must not break the firm on the deploy that introduces it, for a
 * feature they have not seen yet (§15). It also means the hook is correct before `ensureBaseData`
 * has ever run — which is what every integration test relies on.
 */
export async function accessMapFor(user: Pick<User, "id" | "role">): Promise<AccessMap> {
  const { policies, overrides } = await loadTables();
  const role = user.role as UserRole;
  const map = Object.fromEntries(
    GATE_KEYS.map((key) => {
      if (GATES[key].fixedAdmin) return [key, GATES[key].defaults[role]];
      const override = overrides.get(`${user.id}:${key}`);
      if (override) return [key, override];
      return [key, policies.get(`${key}:${role}`) ?? GATES[key].defaults[role]];
    }),
  ) as AccessMap;
  return withDerivedGates(map);
}

export async function stateFor(
  user: Pick<User, "id" | "role">,
  key: GateKey,
): Promise<AccessState> {
  return (await accessMapFor(user))[key];
}

// ── the one hook ─────────────────────────────────────────────────────────────

/**
 * **`onRequest`, not `preHandler`, and one hook rather than one per module.**
 *
 * `onRequest` runs BEFORE body parsing, so a person whose gate is closed is refused before a 25 MB
 * multipart upload is read off the wire. One hook at the root is the only arrangement in which the
 * access table can be the whole truth — and it is what lets the two unsubscribe routes, which live
 * in a child context with their own body parser, be governed like everything else.
 *
 * Services never consult a gate. That is deliberate and it has a name: completing a billable job
 * still issues its invoice when Billing is closed for the person who pressed the button. Money the
 * system decided to bill does not depend on who happened to be at the keyboard. The single
 * sanctioned exception is the calendar's deadline overlay, which is a projection decision rather
 * than an access decision, and has its own test.
 */
export async function accessHook(request: FastifyRequest, reply: FastifyReply) {
  const declared = (request.routeOptions?.config as Partial<RouteAccessConfig> | undefined)
    ?.access;
  // No route matched (404 / the SPA fallback) or a static asset — nothing to decide.
  if (!declared) return;
  if (declared.kind === "anonymous") return;

  request.currentUser = await resolveUser(request, reply);
  if (!request.currentUser) throw new UnauthorizedError();
  if (declared.kind === "shared" || declared.kind === "own") return;

  const state = await stateFor(request.currentUser, declared.gate);
  if (!allowsMethod(state, request.method)) {
    throw new ModuleClosedError(declared.gate, state === "read_only");
  }
  if (
    (declared.adminOnly || GATES[declared.gate].fixedAdmin) &&
    request.currentUser.role !== "admin"
  ) {
    throw new AdminOnlyError(declared.gate);
  }
}

// ── seeding ──────────────────────────────────────────────────────────────────

/**
 * Writes the registry defaults for every (gate, role) that has no row yet, and leaves every
 * existing row alone. Runs with the rest of `ensureBaseData` on every boot.
 *
 * `create`-if-missing rather than `upsert`: an upsert would rewrite the firm's own decisions on
 * every deploy, which is the failure `ensureDefaultMailbox` is written to avoid three models over.
 * A gate the firm has closed stays closed; a gate added by a later release arrives at its default.
 */
export async function ensureAccessPolicies() {
  const existing = new Set(
    (await prisma.accessPolicy.findMany({ select: { gate: true, role: true } })).map(
      (r) => `${r.gate}:${r.role}`,
    ),
  );
  const rows: { gate: string; role: UserRole; state: AccessState }[] = [];
  for (const key of GATE_KEYS) {
    if (GATES[key].fixedAdmin) continue; // no switch, so no row to edit
    for (const role of ["admin", "user"] as const) {
      if (existing.has(`${key}:${role}`)) continue;
      rows.push({ gate: key, role, state: GATES[key].defaults[role] });
    }
  }
  if (rows.length > 0) {
    await prisma.accessPolicy.createMany({ data: rows, skipDuplicates: true });
    invalidateAccessCache();
  }
  return rows.length;
}

/**
 * Policy rows naming a gate this build has never heard of.
 *
 * The one irreversible step in the rollout is seeding real states: roll back to an image that
 * predates a gate and its rows still say `closed` while nothing enforces them — an area the firm
 * believes is shut, quietly open. Nothing else would report it, so the server says so at boot.
 */
export async function unenforceableGates(): Promise<string[]> {
  const rows = await prisma.accessPolicy.findMany({ select: { gate: true }, distinct: ["gate"] });
  return rows
    .map((r) => r.gate)
    .filter((g) => !(GATE_KEYS as string[]).includes(g))
    .sort();
}

/** The number of gate/role pairs the firm has switched away from wide open — printed by deploy. */
export async function closedGateCount(): Promise<number> {
  return prisma.accessPolicy.count({ where: { action: "*", state: { not: "open" } } });
}

export { defaultAccessMap };

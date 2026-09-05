import { z } from "zod";
import type { UserRole } from "./schema/enums.js";

/**
 * **The access registry — what the firm may switch, and what it starts at.**
 *
 * One place that answers "what may this person open, and what may they change". It replaced 46
 * `requireAdmin` guards spread over eight route files plus one role check written inside a
 * service; nothing enumerated them and no test asserted a route had a guard at all.
 *
 * This file is SHARED because both ends need the same list: the server resolves a caller's state
 * from it, and the access screen renders a column per gate from it. A gate that exists on one side
 * only is exactly the drift this module was written to end.
 *
 * See `docs/modules/permissions.md`.
 */

export const accessState = z.enum(["open", "read_only", "closed"]);
export type AccessState = z.infer<typeof accessState>;

/**
 * A gate is a SET OF ROUTES, not a URL prefix. That is the decision the whole design rests on:
 * once each route declares for itself, a module's mutations can carry a gate while its reference
 * reads declare themselves `shared`, which is what makes Settings, Catalog and Team closable at
 * all (an earlier audit concluded they could not be).
 */
export interface GateSpec {
  /**
   * Which switches the ACCESS SCREEN offers for this gate — see the note above `ALL` below. Never
   * all three by default: a control that means nothing is worse than no control, because somebody
   * will set it and believe it.
   */
  states: readonly AccessState[];
  /**
   * `routes` — the hook refuses requests. `screen` — the gate hides a screen and closes no API
   * route, because the screen is a view over records that have gates of their own.
   */
  enforcement: "routes" | "screen";
  /** admin-fixed: no switch, no policy row anyone can edit. Only `team`. */
  fixedAdmin?: true;
  /** What each role gets when no policy row exists. Reproduces the app as it behaved on 2026-09-05. */
  defaults: Record<UserRole, AccessState>;
}

/**
 * **A gate offers `read_only` only where a screen can actually render without its controls.**
 *
 * The hook understands all three states everywhere — `read_only` refuses anything that is not a
 * `GET`, whichever gate it is. What differs is whether the ACCESS SCREEN offers it, and that is
 * decided by the screen on the other end: Services and the Sender tab were already built to be
 * read by everyone and written by an admin, so their read-only mode is real and has been in
 * production for months. The rest were never built that way, and a `read_only` there would leave
 * every button in place and turn each one into a 403 on click — the "screen renders perfectly and
 * only the buttons are dead" failure this codebase has already paid for once (2026-08-26, the
 * Origin check).
 *
 * So they offer `open` and `closed` today. A gate joins `ALL` on the day its screen learns to draw
 * itself without its write controls, and that is one screen's work each, not a rewrite — the state
 * and the enforcement are already here waiting.
 */
const ALL = ["open", "read_only", "closed"] as const;
const ON_OFF = ["open", "closed"] as const;

/**
 * **The defaults reproduce the app exactly as it behaved before this module existed**, measured
 * route by route rather than remembered. `server/access-parity.test.ts` proves it: for every route
 * it asks the old guard and the new registry the same question and requires the same answer.
 *
 * That is why `settings` is `closed` and not `read_only` for a user. The API alone would suggest
 * read-only (the firm profile is readable by anyone, only writes were admin), but the SPA kept
 * `/settings` behind `RequireAdmin` and hid it from the sidebar — so what a PERSON met was a
 * closed area, and seeding `read_only` would have put a new item in everybody's sidebar on deploy
 * day. `mailboxes` is the mirror image: the Sender tab really was visible to everyone, read-only,
 * SMTP and IMAP hostnames included, so `read_only` is what it must start at however much closing
 * it looks like an improvement. Making that improvement is a decision the firm takes on the
 * access screen, on a day of their choosing.
 */
/**
 * The gate's SHAPE. Its words — heading, one-line hint, and the sentence the access screen prints
 * in place — live in `shared/access-copy.ts`, imported only by the screen that renders them and by
 * the server's refusal message. Keeping them apart is not tidiness: this file is imported by the
 * app shell (`src/app/auth.tsx` reads it on every gate check), and prose that only one lazy screen
 * displays would otherwise be downloaded on every first visit. Measured 2026-09-07: 1.8 kB gzip.
 */
const GATE_SPECS = {
  tasks: {
    states: ON_OFF,
    enforcement: "routes",
    defaults: { admin: "open", user: "open" },
  },
  clients: {
    states: ON_OFF,
    enforcement: "routes",
    defaults: { admin: "open", user: "open" },
  },
  secrets: {
    states: ON_OFF,
    enforcement: "routes",
    defaults: { admin: "open", user: "open" },
  },
  leads: {
    states: ON_OFF,
    enforcement: "routes",
    defaults: { admin: "open", user: "open" },
  },
  billing: {
    states: ON_OFF,
    enforcement: "routes",
    defaults: { admin: "open", user: "open" },
  },
  calendar: {
    states: ON_OFF,
    enforcement: "routes",
    defaults: { admin: "open", user: "open" },
  },
  services: {
    states: ALL,
    enforcement: "routes",
    defaults: { admin: "open", user: "read_only" },
  },
  mailouts: {
    states: ON_OFF,
    enforcement: "routes",
    defaults: { admin: "open", user: "open" },
  },
  mailboxes: {
    states: ALL,
    enforcement: "routes",
    defaults: { admin: "open", user: "read_only" },
  },
  archive: {
    states: ON_OFF,
    enforcement: "screen",
    defaults: { admin: "open", user: "open" },
  },
  settings: {
    states: ON_OFF,
    enforcement: "routes",
    defaults: { admin: "open", user: "closed" },
  },
  notification_rules: {
    states: ON_OFF,
    enforcement: "routes",
    defaults: { admin: "open", user: "closed" },
  },
  reports: {
    states: ON_OFF,
    enforcement: "screen",
    defaults: { admin: "open", user: "open" },
  },
  /**
   * The one gate with no switch. If any user could change a role, they could grant themselves
   * every other gate, and the whole table would be decorative. This is the only truly irreducible
   * rule in the module.
   */
  team: {
    states: [],
    enforcement: "routes",
    fixedAdmin: true,
    defaults: { admin: "open", user: "closed" },
  },
} satisfies Record<string, GateSpec>;

export type GateKey = keyof typeof GATE_SPECS;

/**
 * The registry, read as `GateSpec` rather than as its own literal type — `satisfies` above keeps
 * the KEYS exact (that is what `GateKey` is) while this keeps every optional field, `fixedAdmin`
 * most of all, visible to a reader that does not know which gate it holds.
 */
export const GATES: Record<GateKey, GateSpec> = GATE_SPECS;

export const GATE_KEYS = Object.keys(GATES) as GateKey[];

/** The gates the access screen renders a switch for. `team` is fixed and has none. */
export const SWITCHABLE_GATES = GATE_KEYS.filter((g) => !GATES[g].fixedAdmin);

export const gateKey = z.enum(GATE_KEYS as [GateKey, ...GateKey[]]);

export function isGateKey(value: string): value is GateKey {
  return Object.prototype.hasOwnProperty.call(GATES, value);
}

/** The caller's answer for every gate — what `GET /api/auth/me` carries to the SPA. */
export const accessMapSchema = z.record(gateKey, accessState);
export type AccessMap = Record<GateKey, AccessState>;

export function defaultAccessMap(role: UserRole): AccessMap {
  return Object.fromEntries(
    GATE_KEYS.map((key) => [key, GATES[key].defaults[role]]),
  ) as AccessMap;
}

/**
 * The Archive is DERIVED as well as switched: it is a view over three other modules, so when all
 * three are closed there is nothing behind the screen to open. Not a fourth stored switch — a
 * firm that closed Clients, Leads and Tasks and still saw "Archive" in the sidebar would be
 * looking at a promise the app cannot keep.
 */
export function withDerivedGates(map: AccessMap): AccessMap {
  const sources: GateKey[] = ["clients", "leads", "tasks"];
  if (map.archive !== "closed" && sources.every((g) => map[g] === "closed")) {
    return { ...map, archive: "closed" };
  }
  return map;
}

/** A `read_only` gate allows exactly the safe methods. Everything else is a change. */
export const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export function allowsMethod(state: AccessState, method: string): boolean {
  if (state === "closed") return false;
  if (state === "open") return true;
  return READ_METHODS.has(method.toUpperCase());
}

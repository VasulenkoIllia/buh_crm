import argon2 from "argon2";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GATES,
  GATE_KEYS,
  allowsMethod,
  type AccessState,
  type GateKey,
} from "@shared/access.js";
import { buildApp } from "./app.js";
import { prisma } from "./core/db.js";
import { invalidateAccessCache } from "./core/access.js";
import type { RouteRecord } from "./core/route-inventory.js";

/**
 * **Every gate, in every state, against every route it governs — as real HTTP.**
 *
 * `access-parity.test.ts` proves the shipped DEFAULTS reproduce the old guards, and
 * `access.integration.test.ts` proves each mechanism works on a representative route. Neither of
 * them would notice a single route wearing the wrong declaration: a `POST` that somebody wrote as
 * `shared()`, a gate whose name is one letter out, a route that quietly answers when its area is
 * shut. This does — by walking the committed inventory and firing an actual request for every
 * (route × state × role) the app can be in.
 *
 * Roughly 900 requests. The URLs carry a random uuid where a path parameter is needed, so a route
 * that gets past the gate answers 400 or 404 — which is the assertion: **anything that is not 403
 * means the access layer let it through**, and a 403 must carry the code that says why. Nothing
 * here can create or destroy a record, because no id it sends exists.
 *
 * The suite writes policy rows DIRECTLY rather than through `/api/access`, because the hook
 * supports all three states for every gate while the screen only offers `read_only` where a screen
 * can render it (see `shared/access.ts`). The enforcement is what is under test here, not the
 * screen's menu.
 */

let app: Awaited<ReturnType<typeof buildApp>>;
let userCookie: string;
let adminCookie: string;
let routes: RouteRecord[];

const SOME_UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

/** `/api/clients/:id/files/:fileId` → `/api/clients/<uuid>/files/<uuid>` */
const concrete = (url: string) =>
  url
    .split("/")
    .map((seg) => (seg.startsWith(":") ? SOME_UUID : seg))
    .join("/");

async function setState(gate: GateKey, role: "admin" | "user", state: AccessState) {
  await prisma.accessPolicy.upsert({
    where: { gate_role_action: { gate, role, action: "*" } },
    update: { state },
    create: { gate, role, state },
  });
  invalidateAccessCache();
}

beforeAll(async () => {
  app = await buildApp();
  routes = (
    JSON.parse(await readFile(new URL("route-inventory.json", import.meta.url), "utf8")) as
      RouteRecord[]
  ).filter((r) => !r.derived);

  await prisma.accessOverride.deleteMany();
  await prisma.accessPolicy.deleteMany();
  await prisma.session.deleteMany({ where: { user: { email: { endsWith: "@matrix.local" } } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: "@matrix.local" } } });

  const passwordHash = await argon2.hash("password-123");
  for (const [email, role] of [
    ["admin@matrix.local", "admin"],
    ["user@matrix.local", "user"],
  ] as const) {
    await prisma.user.create({
      data: { firstName: "Matrix", lastName: role, email, passwordHash, role, status: "active" },
    });
  }
  const login = async (email: string) =>
    cookieOf(
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email, password: "password-123" },
      }),
    );
  adminCookie = await login("admin@matrix.local");
  userCookie = await login("user@matrix.local");
});

afterAll(async () => {
  await prisma.accessOverride.deleteMany();
  await prisma.accessPolicy.deleteMany();
  await prisma.session.deleteMany({ where: { user: { email: { endsWith: "@matrix.local" } } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: "@matrix.local" } } });
  await app?.close();
});

/** What the access layer should answer, from the declaration alone. */
function expected(record: RouteRecord, state: AccessState, isAdmin: boolean) {
  const [, gateName, flag] = record.access.split(":");
  const spec = GATES[gateName as GateKey];
  if (!allowsMethod(state, record.method)) return "module_closed" as const;
  if ((flag === "admin" || spec.fixedAdmin) && !isAdmin) return "admin_only" as const;
  return "through" as const;
}

async function probe(record: RouteRecord, cookie: string) {
  const res = await app.inject({
    method: record.method as "GET",
    url: concrete(record.url),
    headers: { cookie },
    ...(["POST", "PUT", "PATCH"].includes(record.method) ? { payload: {} } : {}),
  });
  /**
   * `forbidden` is deliberately treated as "got through": it is what a SERVICE throws once the
   * access layer has already allowed the request — the secrets vault asking for a password, an
   * ownership rule refusing somebody else's row. Only the two codes the hook itself emits count as
   * an access refusal, which is exactly why they have their own names.
   */
  const raw = res.statusCode === 403 ? (res.json().error?.code as string) : null;
  const code = raw === "module_closed" || raw === "admin_only" ? raw : "through";
  return { status: res.statusCode, code, raw };
}

describe("the access matrix", () => {
  /**
   * The gates with routes, each walked in all three states. `read_only` is exercised even where
   * the screen does not offer it — the hook has to be correct for the day a screen learns to
   * render without its write controls, and this is what says it already is.
   */
  const gatedRoutes = () => routes.filter((r) => r.access.startsWith("gate:"));

  for (const state of ["open", "read_only", "closed"] as const) {
    it(`answers every gated route correctly with its gate ${state} for a plain user`, async () => {
      for (const gate of GATE_KEYS) {
        if (GATES[gate].fixedAdmin) continue;
        await setState(gate, "user", state);
      }

      const wrong: string[] = [];
      for (const record of gatedRoutes()) {
        const gate = record.access.split(":")[1] as GateKey;
        // `team` is fixed admin: its state is not ours to set, and it is always closed to a user
        const effective = GATES[gate].fixedAdmin ? GATES[gate].defaults.user : state;
        const want = expected(record, effective, false);
        const got = await probe(record, userCookie);
        if (got.code !== want) {
          wrong.push(
            `${record.method} ${record.url} (${record.access}, ${effective}): wanted ${want}, ` +
              `got ${got.code} [${got.status}]`,
          );
        }
      }
      expect(wrong).toEqual([]);
    });
  }

  it("answers every gated route for an admin, whose gates are open", async () => {
    for (const gate of GATE_KEYS) {
      if (GATES[gate].fixedAdmin) continue;
      await setState(gate, "admin", "open");
    }
    const wrong: string[] = [];
    for (const record of gatedRoutes()) {
      const got = await probe(record, adminCookie);
      if (got.code !== "through") {
        wrong.push(`${record.method} ${record.url}: admin was refused — ${got.code} [${got.status}]`);
      }
    }
    expect(wrong).toEqual([]);
  });

  /**
   * The reference surface, walked in full rather than sampled. Every `shared()` and `own()` route
   * must answer with EVERY gate shut — these are the reads the app shell and four other screens
   * are built on, and gating one by accident is the failure that would look like the app being
   * broken rather than like an access decision.
   */
  it("answers every shared() and own() route with every gate closed", async () => {
    for (const gate of GATE_KEYS) {
      if (GATES[gate].fixedAdmin) continue;
      await setState(gate, "user", "closed");
    }
    const wrong: string[] = [];
    for (const record of routes.filter((r) => ["shared", "own"].includes(r.access))) {
      const got = await probe(record, userCookie);
      if (got.code !== "through") {
        wrong.push(`${record.method} ${record.url} (${record.access}): refused — ${got.code}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  /** No session at all: everything but the eight public routes must be 401, never 403 or 200. */
  it("refuses every declared route to a caller with no session", async () => {
    const wrong: string[] = [];
    for (const record of routes) {
      const res = await app.inject({
        method: record.method as "GET",
        url: concrete(record.url),
        ...(["POST", "PUT", "PATCH"].includes(record.method) ? { payload: {} } : {}),
      });
      const isPublic = record.access === "anonymous";
      if (isPublic ? res.statusCode === 401 : res.statusCode !== 401) {
        wrong.push(`${record.method} ${record.url} (${record.access}): ${res.statusCode}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  /**
   * A blocked person's session stops working immediately — `resolveUser` refuses any status but
   * `active`, so this is 401 rather than a gate refusal, whatever their gates say.
   */
  it("refuses a blocked person everywhere, whatever their gates say", async () => {
    for (const gate of GATE_KEYS) {
      if (GATES[gate].fixedAdmin) continue;
      await setState(gate, "user", "open");
    }
    await prisma.user.update({
      where: { email: "user@matrix.local" },
      data: { status: "blocked" },
    });
    invalidateAccessCache();

    for (const url of ["/api/auth/me", "/api/settings", "/api/tasks", "/api/clients"]) {
      const res = await app.inject({ method: "GET", url, headers: { cookie: userCookie } });
      expect(res.statusCode, url).toBe(401);
    }

    await prisma.user.update({
      where: { email: "user@matrix.local" },
      data: { status: "active" },
    });
  });

  /**
   * An override wins over the role for every gate, in both directions — not just the one gate the
   * behaviour suite spot-checks.
   */
  it("lets an override beat the role on every gate, both ways", async () => {
    const person = await prisma.user.findFirstOrThrow({ where: { email: "user@matrix.local" } });
    const probeGate = async (gate: GateKey) => {
      const one = routes.find(
        (r) => r.access === `gate:${gate}` && r.method === "GET",
      );
      return one ? probe(one, userCookie) : null;
    };

    for (const gate of GATE_KEYS) {
      if (GATES[gate].fixedAdmin) continue;
      const sample = await probeGate(gate);
      if (!sample) continue; // a screen-only gate has nothing to fire at

      await setState(gate, "user", "closed");
      await prisma.accessOverride.deleteMany({ where: { userId: person.id, gate } });
      invalidateAccessCache();
      expect((await probeGate(gate))!.code, `${gate}: role closed`).toBe("module_closed");

      await prisma.accessOverride.create({
        data: { userId: person.id, gate, state: "open" },
      });
      invalidateAccessCache();
      expect((await probeGate(gate))!.code, `${gate}: override opens`).toBe("through");

      await setState(gate, "user", "open");
      await prisma.accessOverride.update({
        where: { userId_gate_action: { userId: person.id, gate, action: "*" } },
        data: { state: "closed" },
      });
      invalidateAccessCache();
      expect((await probeGate(gate))!.code, `${gate}: override closes`).toBe("module_closed");

      await prisma.accessOverride.deleteMany({ where: { userId: person.id, gate } });
      invalidateAccessCache();
    }
  });
});

/**
 * The registry describes itself honestly.
 *
 * `enforcement` was declared with the module and read by nothing — the kind of metadata that
 * becomes a lie the first time somebody adds a route to a gate documented as closing none. These
 * hold it to the inventory, which makes the field load-bearing rather than decorative.
 */
describe("the registry matches the routes it claims to govern", () => {
  it("gives every routes-enforced gate at least one route, and every screen-enforced gate none", async () => {
    const counted = new Map<string, number>();
    for (const r of routes.filter((x) => x.access.startsWith("gate:"))) {
      const gate = r.access.split(":")[1];
      counted.set(gate, (counted.get(gate) ?? 0) + 1);
    }
    const wrong: string[] = [];
    for (const gate of GATE_KEYS) {
      const n = counted.get(gate) ?? 0;
      if (GATES[gate].enforcement === "routes" && n === 0) {
        wrong.push(`${gate}: declared enforcement "routes" but governs no route`);
      }
      if (GATES[gate].enforcement === "screen" && n > 0) {
        wrong.push(
          `${gate}: declared enforcement "screen" — it is documented as hiding a screen and ` +
            `closing no API route — but now governs ${n}. Change the registry, or the route.`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  /**
   * `own()` means "acts only on the caller's own row". A route taking an id in its path is making
   * a claim about somebody the caller named, which is a different question — `POST /timer/start`
   * shipped as `own()` and was really a write into the Tasks module (audit, 2026-09-07).
   *
   * `/:id/read` on the tray is the sanctioned exception: the id names a NOTIFICATION and the
   * service resolves it inside the caller's own rows, so it cannot address anybody else's.
   */
  it("keeps own() routes free of a subject the caller could name", () => {
    const allowed = new Set(["POST /api/notifications/:id/read"]);
    const suspicious = routes
      .filter((r) => r.access === "own" && r.url.includes("/:"))
      .map((r) => `${r.method} ${r.url}`)
      .filter((k) => !allowed.has(k));
    expect(
      suspicious,
      "an own() route with a path parameter names something the caller chose — check it really " +
        "cannot reach another person's row, then add it to `allowed` with the reason",
    ).toEqual([]);
  });

  /** Every gate the registry declares is reachable from the access screen, or is `team`. */
  it("offers a switch for every gate except the fixed one", () => {
    const noSwitch = GATE_KEYS.filter((g) => GATES[g].states.length === 0);
    expect(noSwitch).toEqual(["team"]);
  });

  /** Whatever a gate offers, it offers `open` — there is no gate that can only be shut. */
  it("lets every switchable gate be opened again", () => {
    const oneWay = GATE_KEYS.filter(
      (g) => !GATES[g].fixedAdmin && !GATES[g].states.includes("open"),
    );
    expect(oneWay).toEqual([]);
  });
});

/**
 * **What has to keep working when the next module arrives.**
 *
 * The whole design rests on one guarantee: a route that declares nothing does not ship. Everything
 * else — the fixture, the parity table, the matrix above — describes the API as it is today and
 * would say nothing at all about a route somebody adds next month. This is the part that does.
 */
describe("the guarantees a future module depends on", () => {
  it("refuses to build an app containing a route that declares no access", async () => {
    const { default: Fastify } = await import("fastify");
    const { collectRouteInventory } = await import("./core/route-inventory.js");

    const instance = Fastify({ logger: false });
    collectRouteInventory(instance);
    expect(() =>
      instance.get("/api/whatever-comes-next", async () => ({ ok: true })),
    ).toThrowError(/declares no access/);
    await instance.close();
  });

  /** Outside `/api` there is nothing to declare — `/health` and, in production, the SPA's files. */
  it("lets a non-/api route through undeclared", async () => {
    const { default: Fastify } = await import("fastify");
    const { collectRouteInventory } = await import("./core/route-inventory.js");

    const instance = Fastify({ logger: false });
    collectRouteInventory(instance);
    expect(() => instance.get("/some-static-thing", async () => ({ ok: true }))).not.toThrow();
    await instance.close();
  });

  /**
   * A gate added by a later release arrives at its own default rather than shut, and a gate the
   * firm has already decided about is never rewritten by a deploy. Both halves matter: the first
   * is what stops a new feature breaking the firm on the day it lands, the second is what stops
   * every deploy undoing their decisions.
   */
  it("seeds a missing gate and leaves a decided one alone", async () => {
    const { ensureAccessPolicies } = await import("./core/access.js");
    await prisma.accessPolicy.deleteMany();

    const seeded = await ensureAccessPolicies();
    const switchable = GATE_KEYS.filter((g) => !GATES[g].fixedAdmin);
    expect(seeded).toBe(switchable.length * 2);
    for (const gate of switchable) {
      for (const role of ["admin", "user"] as const) {
        const row = await prisma.accessPolicy.findUniqueOrThrow({
          where: { gate_role_action: { gate, role, action: "*" } },
        });
        expect(row.state, `${gate}/${role}`).toBe(GATES[gate].defaults[role]);
      }
    }

    // the firm decides something, a later release adds a gate, the next boot seeds only the gap
    await prisma.accessPolicy.update({
      where: { gate_role_action: { gate: "billing", role: "user", action: "*" } },
      data: { state: "closed" },
    });
    await prisma.accessPolicy.deleteMany({ where: { gate: "calendar" } });
    expect(await ensureAccessPolicies()).toBe(2);
    expect(
      (
        await prisma.accessPolicy.findUniqueOrThrow({
          where: { gate_role_action: { gate: "billing", role: "user", action: "*" } },
        })
      ).state,
    ).toBe("closed");

    // `team` is fixed admin and gets no row at all — there is nothing for anybody to edit
    expect(await prisma.accessPolicy.count({ where: { gate: "team" } })).toBe(0);
    await prisma.accessPolicy.deleteMany();
  });

  /**
   * The one irreversible step of the rollout, made visible. Roll back to an image that predates a
   * gate and its rows survive with nothing to enforce them — an area the firm believes is shut,
   * quietly open. Nothing else in the system would ever say so.
   */
  it("reports policy rows naming a gate this build cannot enforce", async () => {
    const { unenforceableGates, closedGateCount } = await import("./core/access.js");
    await prisma.accessPolicy.deleteMany();
    expect(await unenforceableGates()).toEqual([]);

    await prisma.accessPolicy.createMany({
      data: [
        { gate: "payroll", role: "user", state: "closed" },
        { gate: "billing", role: "user", state: "closed" },
      ],
    });
    expect(await unenforceableGates()).toEqual(["payroll"]);
    expect(await closedGateCount()).toBe(2);
    await prisma.accessPolicy.deleteMany();
  });

  /**
   * Stage 2 is per-ACTION rules, and the column they will live in ships now, inert, inside the
   * composite primary key — because adding a column to a composite key later is the one change
   * that would not be additive. This is the assertion that it is really there and really unused.
   */
  it("carries the inert action column that keeps stage 2 additive", async () => {
    await prisma.accessPolicy.deleteMany();
    await prisma.accessPolicy.createMany({
      data: [
        { gate: "billing", role: "user", state: "open" },
        { gate: "billing", role: "user", action: "invoice.cancel", state: "closed" },
      ],
    });
    // two rows for one (gate, role) coexist — which is the whole point of the column
    expect(await prisma.accessPolicy.count({ where: { gate: "billing", role: "user" } })).toBe(2);

    /**
     * And today's resolver reads only the "*" row, so the second changes nothing yet.
     *
     * It did not, when this test was written: `loadTables` keyed its map by `gate:role` and
     * ignored `action` entirely, so the first per-action row stage 2 ever wrote would have
     * collided with the gate's own and — depending on row order — closed Billing for the whole
     * firm. That is the failure this assertion exists to have caught (2026-09-07).
     */
    const { accessMapFor, invalidateAccessCache: drop } = await import("./core/access.js");
    drop();
    const person = await prisma.user.findFirstOrThrow({ where: { email: "user@matrix.local" } });
    expect((await accessMapFor(person)).billing).toBe("open");
    await prisma.accessPolicy.deleteMany();
  });
});

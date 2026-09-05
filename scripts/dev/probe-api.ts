/**
 * The notification API, probed over real HTTP against the running dev server.
 *
 * What the integration suite cannot reach: the Origin (CSRF) check, the rate limiter, malformed
 * bodies, and what the tray does when somebody has far more unread rows than it renders.
 * DEV ONLY — it creates its own users under @apiprobe.local and removes them.
 */
import argon2 from "argon2";
import { prisma } from "../../server/core/db.js";

const API = "http://localhost:3000";
const findings: string[] = [];
const ok = (s: string) => console.log(`  OK    ${s}`);
const bad = (s: string) => {
  console.log(`  ISSUE ${s}`);
  findings.push(s);
};

async function login(email: string, password: string) {
  const r = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const raw = r.headers.getSetCookie?.() ?? [];
  if (!raw.length) throw new Error(`login failed for ${email}: ${r.status} ${await r.text()}`);
  return raw[0].split(";")[0];
}

const call = (path: string, cookie: string, init: RequestInit = {}) =>
  fetch(`${API}${path}`, {
    ...init,
    headers: {
      cookie,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

async function main() {
  const hash = await argon2.hash("probe-password-123");
  const mk = (first: string, role: "admin" | "user") =>
    prisma.user.upsert({
      where: { email: `${first}@apiprobe.local` },
      update: { passwordHash: hash, status: "active", role },
      create: {
        firstName: first,
        lastName: "Api",
        email: `${first}@apiprobe.local`,
        passwordHash: hash,
        role,
        status: "active",
      },
    });

  const boss = await mk("boss", "admin");
  const staff = await mk("staff", "user");
  const other = await mk("other", "user");
  const bossCookie = await login("boss@apiprobe.local", "probe-password-123");
  const staffCookie = await login("staff@apiprobe.local", "probe-password-123");

  const seed = (userId: string, n: number, read = false) =>
    prisma.notification.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        userId,
        trigger: "task_assigned",
        reason: "assignee" as const,
        text: `probe row ${i}`,
        dedupKey: `task_assigned:probe-${userId}-${i}`,
        ...(read ? { readAt: new Date() } : {}),
      })),
    });

  // ── 1. the Origin check (CSRF) ────────────────────────────────────────────
  console.log("\n1. cross-origin writes");
  await seed(staff.id, 1);
  const mine = await prisma.notification.findFirstOrThrow({ where: { userId: staff.id } });
  const forged = await call(`/api/notifications/${mine.id}/read`, staffCookie, {
    method: "POST",
    headers: { origin: "https://evil.example" },
  });
  if (forged.status === 403) ok("a POST from another origin is refused (403)");
  else bad(`a cross-origin dismiss returned ${forged.status}, not 403`);

  const forgedPrefs = await call("/api/notifications/preferences", staffCookie, {
    method: "PUT",
    headers: { origin: "https://evil.example" },
    body: JSON.stringify({
      changes: [{ trigger: "task_assigned", channel: "email", enabled: false }],
    }),
  });
  if (forgedPrefs.status === 403) ok("a cross-origin preference write is refused too");
  else bad(`a cross-origin preference write returned ${forgedPrefs.status}`);

  // ── 2. one person's tray is not another's ─────────────────────────────────
  console.log("\n2. whose tray is it");
  await seed(other.id, 1);
  const theirs = await prisma.notification.findFirstOrThrow({ where: { userId: other.id } });
  const peek = await call(`/api/notifications/${theirs.id}/read`, bossCookie, {
    method: "POST",
  });
  if (peek.status === 404)
    ok("an ADMIN cannot dismiss somebody else's row (404, not 403 — no existence leak)");
  else bad(`an admin dismissing another user's row returned ${peek.status}`);
  const stillUnread = await prisma.notification.findUnique({ where: { id: theirs.id } });
  if (stillUnread?.readAt === null) ok("and the row is untouched");
  else bad("the row was modified anyway");

  const staffPolicies = await call("/api/notifications/policies", staffCookie);
  if (staffPolicies.status === 403) ok("a non-admin cannot read the firm's policy");
  else bad(`a non-admin read policies with ${staffPolicies.status}`);

  // ── 3. malformed input ────────────────────────────────────────────────────
  console.log("\n3. input the UI would never send");
  const cases: Array<[string, unknown, number[]]> = [
    [
      "an unknown trigger",
      { changes: [{ trigger: "not_a_trigger", channel: "email", enabled: true }] },
      [400, 404],
    ],
    [
      "an unknown channel",
      { changes: [{ trigger: "task_assigned", channel: "carrier_pigeon", enabled: true }] },
      [400],
    ],
    ["an empty change list", { changes: [] }, [400]],
    [
      "1000 changes at once",
      {
        changes: Array.from({ length: 1000 }, () => ({
          trigger: "task_assigned",
          channel: "email",
          enabled: false,
        })),
      },
      [400],
    ],
    [
      "a string where a boolean goes",
      { changes: [{ trigger: "task_assigned", channel: "email", enabled: "yes" }] },
      [400],
    ],
    ["no body at all", {}, [400]],
  ];
  for (const [label, body, want] of cases) {
    const r = await call("/api/notifications/preferences", staffCookie, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    if (want.includes(r.status)) ok(`${label} -> ${r.status}`);
    else bad(`${label} -> ${r.status}, expected one of ${want.join("/")}`);
  }
  const badId = await call("/api/notifications/not-a-uuid/read", staffCookie, {
    method: "POST",
  });
  if (badId.status === 400) ok(`a malformed id -> 400`);
  else bad(`a malformed id -> ${badId.status}`);

  const badPolicy = await call("/api/notifications/policies/task_assigned", bossCookie, {
    method: "PATCH",
    body: JSON.stringify({}),
  });
  if (badPolicy.status === 400)
    ok("an empty policy patch is refused rather than being a no-op write");
  else bad(`an empty policy patch -> ${badPolicy.status}`);

  // ── 4. a tray with far more than it renders ───────────────────────────────
  console.log("\n4. a hundred unread rows");
  await prisma.notification.deleteMany({ where: { userId: staff.id } });
  await seed(staff.id, 100);
  const tray = await (await call("/api/notifications", staffCookie)).json();
  if (tray.unread === 100) ok("the badge counts all 100, not the page");
  else bad(`the badge said ${tray.unread}`);
  if (tray.items.length === 20) ok("the tray renders 20 and no more");
  else bad(`the tray returned ${tray.items.length} rows`);
  if (tray.unread > tray.items.length) {
    bad(
      `80 unread rows are counted in the badge and reachable by NO screen — there is no paging ` +
        `and no history. The only way out is "Mark all read", which discards them unseen.`,
    );
  }

  const markAll = await call("/api/notifications/read-all", staffCookie, { method: "POST" });
  const body = await markAll.json();
  if (markAll.status === 200 && body.count === 100)
    ok(`"Mark all read" cleared all 100 in one call`);
  else bad(`mark-all-read -> ${markAll.status} count=${JSON.stringify(body)}`);
  const after = await (await call("/api/notifications", staffCookie)).json();
  if (after.unread === 0) ok("the badge is back to zero");
  else bad(`the badge is ${after.unread}`);

  // ── 5. an unauthenticated caller ──────────────────────────────────────────
  console.log("\n5. no session at all");
  for (const [label, path, init] of [
    ["the tray", "/api/notifications", {}],
    ["preferences", "/api/notifications/preferences", {}],
    ["policies", "/api/notifications/policies", {}],
  ] as Array<[string, string, RequestInit]>) {
    const r = await fetch(`${API}${path}`, init);
    if (r.status === 401) ok(`${label} -> 401`);
    else bad(`${label} without a session -> ${r.status}`);
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  const ids = [boss.id, staff.id, other.id];
  await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await prisma.notificationPreference.deleteMany({ where: { userId: { in: ids } } });
  await prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });

  console.log(
    `\n${findings.length === 0 ? "no issues found" : `${findings.length} FINDING(S):`}`,
  );
  for (const f of findings) console.log(`  - ${f}`);
}

await main();
await prisma.$disconnect();

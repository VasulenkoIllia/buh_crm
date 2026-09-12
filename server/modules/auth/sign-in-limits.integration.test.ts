import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { deleteExpiredSessions, SESSION_IDLE_MS, SESSION_MAX_AGE_MS } from "../../core/auth.js";
import { prisma } from "../../core/db.js";
import { testOutbox } from "../../core/email.js";

/**
 * docs/modules/two-factor.md, Phase A — the half of the module that protects everybody, including
 * whoever never switches a second factor on: sessions that end (§8), and failed sign-ins that are
 * answered rather than only recorded (§9).
 */

let app: Awaited<ReturnType<typeof buildApp>>;
const DAY = 24 * 60 * 60 * 1000;
const PASSWORD = "Right-Pass-1234";
const DOMAIN = "@limits.test.local";
const FORGED_AGENT = "Totally legit - call +1 555 0100 to unlock your account";

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

async function person(name: string, role: "user" | "admin" = "user") {
  const email = `${name}${DOMAIN}`;
  return prisma.user.upsert({
    where: { email },
    update: { status: "active", role },
    create: {
      email,
      firstName: name,
      lastName: "Limits",
      role,
      status: "active",
      passwordHash: await argon2.hash(PASSWORD),
    },
  });
}

function attempt(
  email: string,
  password: string,
  options: { from?: string; userAgent?: string } = {},
) {
  return app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: options.from ?? "198.51.100.10",
    headers: options.userAgent ? { "user-agent": options.userAgent } : {},
    payload: { email, password },
  });
}

/** The activity log is flushed after the response; poll for what it should now say. */
async function eventually<T>(read: () => Promise<T | null | undefined>, what: string) {
  for (let i = 0; i < 40; i++) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`never appeared: ${what}`);
}

async function cleanUp() {
  await prisma.signInThrottle.deleteMany({ where: { key: { contains: DOMAIN } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
}

beforeAll(async () => {
  app = await buildApp();
  await cleanUp();
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe("how long a session lives (§8)", () => {
  let userId: string;
  let email: string;

  beforeAll(async () => {
    const user = await person("lifetime");
    userId = user.id;
    email = user.email;
  });

  async function freshSession() {
    const res = await attempt(email, PASSWORD);
    expect(res.statusCode).toBe(200);
    const session = await prisma.session.findFirstOrThrow({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    return { cookie: cookieOf(res), session };
  }

  const me = (cookie: string) =>
    app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });

  it("opens for a week, and the cookie says so", async () => {
    const before = Date.now();
    const res = await attempt(email, PASSWORD);
    expect(String(res.headers["set-cookie"])).toContain(`Max-Age=${SESSION_IDLE_MS / 1000}`);
    const session = await prisma.session.findFirstOrThrow({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    const lifetime = session.expiresAt.getTime() - before;
    expect(lifetime).toBeGreaterThan(SESSION_IDLE_MS - 60_000);
    expect(lifetime).toBeLessThanOrEqual(SESSION_IDLE_MS + 1_000);
  });

  it("slides at most once a day — and moves the browser's cookie with it", async () => {
    const { cookie, session } = await freshSession();

    // used a moment ago: not a day behind, so nothing is written and no cookie is sent
    const quiet = await me(cookie);
    expect(quiet.statusCode).toBe(200);
    expect(quiet.headers["set-cookie"]).toBeUndefined();

    // two days without a request
    await prisma.session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() + 5 * DAY) },
    });
    const slid = await me(cookie);
    expect(slid.statusCode).toBe(200);
    expect(String(slid.headers["set-cookie"])).toContain("Max-Age=");
    const after = await prisma.session.findUniqueOrThrow({ where: { id: session.id } });
    expect(after.expiresAt.getTime()).toBeGreaterThan(Date.now() + SESSION_IDLE_MS - 60_000);
  });

  it("ends after a week without use", async () => {
    const { cookie, session } = await freshSession();
    await prisma.session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    expect((await me(cookie)).statusCode).toBe(401);
  });

  /** The bound a sliding session never had: used every day, it never ended at all. */
  it("ends thirty days after it opened, however recently it was used", async () => {
    const { cookie, session } = await freshSession();
    await prisma.session.update({
      where: { id: session.id },
      data: {
        createdAt: new Date(Date.now() - SESSION_MAX_AGE_MS - 1_000),
        expiresAt: new Date(Date.now() + 5 * DAY),
      },
    });
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it("never slides past the thirtieth day", async () => {
    const { cookie, session } = await freshSession();
    const openedAt = Date.now() - 27 * DAY;
    await prisma.session.update({
      where: { id: session.id },
      data: { createdAt: new Date(openedAt), expiresAt: new Date(Date.now() + DAY) },
    });
    expect((await me(cookie)).statusCode).toBe(200);
    const after = await prisma.session.findUniqueOrThrow({ where: { id: session.id } });
    expect(after.expiresAt.getTime()).toBe(openedAt + SESSION_MAX_AGE_MS);
  });

  /** Deploy day: a thirty-day expiry from before is pulled in, and its owner keeps working. */
  it("pulls an expiry set under the old rule in to a week, without signing anybody out", async () => {
    const { cookie, session } = await freshSession();
    await prisma.session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() + 25 * DAY) },
    });
    expect((await me(cookie)).statusCode).toBe(200);
    const after = await prisma.session.findUniqueOrThrow({ where: { id: session.id } });
    expect(after.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + SESSION_IDLE_MS);
  });

  it("clears a session past the thirty days in the nightly sweep", async () => {
    const { session } = await freshSession();
    await prisma.session.update({
      where: { id: session.id },
      data: { createdAt: new Date(Date.now() - SESSION_MAX_AGE_MS - DAY) },
    });
    await deleteExpiredSessions();
    expect(await prisma.session.findUnique({ where: { id: session.id } })).toBeNull();
  });
});

describe("failed sign-ins are answered (§9)", () => {
  /**
   * The property the address-keyed limiter never had: ten addresses were ten budgets against one
   * account. Here no address repeats, and the sixth attempt — with the RIGHT password — still waits.
   */
  it("holds one account across changing addresses", async () => {
    const { email } = await person("roaming");
    const before = new Date();
    for (let i = 1; i <= 5; i++) {
      const res = await attempt(email, "wrong-guess", { from: `198.51.100.${i}` });
      expect(res.statusCode).toBe(401);
    }

    const res = await attempt(email, PASSWORD, { from: "198.51.100.99" });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("too_many_attempts");
    expect(res.json().error.message).toMatch(/Try again in \d+ seconds?/);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);

    // no session came of it: the password was never even checked
    expect(await prisma.session.count({ where: { user: { email } } })).toBe(0);
    // …and the refusal is in the log, with its own reason, attributed to nobody
    const row = await eventually(async () => {
      const rows = await prisma.activityEvent.findMany({
        where: { action: "session.sign_in_failed", occurredAt: { gte: before } },
      });
      return rows.find((r) => {
        const changes = r.changes as { email?: string; reason?: string } | null;
        return changes?.email === email && changes.reason === "throttled";
      });
    }, "the throttled attempt");
    expect(row.actorKind).toBe("system");
  });

  /** Keyed by account, the throttle would say which addresses have one. It is keyed by what was typed. */
  it("slows an address with no account exactly like one that has an account", async () => {
    const { email: real } = await person("real");
    const ghost = `ghost${DOMAIN}`;
    const before = testOutbox.length;
    for (let i = 0; i < 5; i++) {
      expect((await attempt(real, "wrong-guess")).statusCode).toBe(401);
      expect((await attempt(ghost, "wrong-guess")).statusCode).toBe(401);
    }

    const a = await attempt(real, "wrong-guess");
    const b = await attempt(ghost, "wrong-guess");
    expect(a.statusCode).toBe(429);
    expect(b.statusCode).toBe(429);
    expect(b.json().error.code).toBe(a.json().error.code);
    expect(Object.keys(b.headers)).toContain("retry-after");
    // there is nobody to tell about the address with no account
    expect(testOutbox.slice(before).some((m) => m.to === ghost)).toBe(false);
  });

  it("forgives the count on a successful sign-in", async () => {
    const { email } = await person("forgiven");
    for (let i = 0; i < 4; i++) await attempt(email, "wrong-guess");
    expect((await attempt(email, PASSWORD)).statusCode).toBe(200);
    // four more: had the success not cleared the first four, the second of these would wait
    for (let i = 0; i < 4; i++) {
      expect((await attempt(email, "wrong-guess")).statusCode).toBe(401);
    }
  });

  /**
   * The letter goes out after the refusal has been answered (`refuse` does not wait for it — a
   * response that did would be slower for real accounts only), so these wait for it to arrive, and
   * give a letter that should NOT arrive a moment to prove it.
   */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
  const lettersTo = (to: string, since: number) =>
    testOutbox.slice(since).filter((m) => m.to === to);

  it("writes one letter per run — to the owner, and a copy to every other admin", async () => {
    const { email } = await person("lettered");
    const otherAdmin = await person("second-admin", "admin");
    const before = testOutbox.length;

    for (let i = 0; i < 5; i++) {
      expect(
        (await attempt(email, "wrong-guess", { userAgent: FORGED_AGENT })).statusCode,
      ).toBe(401);
    }

    // the admins' copies go out after the owner's letter, so once one is here both are
    const [copy] = await eventually(async () => {
      const found = lettersTo(otherAdmin.email, before);
      return found.length > 0 ? found : null;
    }, "the admin's copy");
    expect(copy.text).toContain(email); // it names whose account it was

    const own = lettersTo(email, before);
    expect(own).toHaveLength(1);
    expect(own[0].subject).toMatch(/Failed sign-ins on your/);
    expect(own[0].text).toContain("198.51.100.10");
    // the browser line is chosen from a list; not one word the caller wrote reaches the reader
    expect(own[0].text).toContain("an unrecognised browser");
    expect(own[0].html).not.toContain("555 0100");

    // the run carries on once its wait is over: the same run, and still one letter each
    await prisma.signInThrottle.updateMany({
      where: { key: { contains: email } },
      data: { lastFailureAt: new Date(Date.now() - 5_000) },
    });
    expect((await attempt(email, "wrong-guess")).statusCode).toBe(401);
    await settle();
    expect(lettersTo(email, before)).toHaveLength(1);
    expect(lettersTo(otherAdmin.email, before)).toHaveLength(1);
  });

  it("does not write to an admin about their own account twice", async () => {
    const { email } = await person("admin-target", "admin");
    const before = testOutbox.length;
    for (let i = 0; i < 5; i++) await attempt(email, "wrong-guess");
    await eventually(
      async () => (lettersTo(email, before).length > 0 ? true : null),
      "the letter",
    );
    await settle();
    expect(lettersTo(email, before)).toHaveLength(1);
  });
});

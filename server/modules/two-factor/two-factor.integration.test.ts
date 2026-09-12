import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { prisma } from "../../core/db.js";
import { testOutbox } from "../../core/email.js";
import { base32Decode, hotp, stepAt } from "../../core/totp.js";

/**
 * docs/modules/two-factor.md §15 — the tests that would not exist without the spec, driven through
 * the real HTTP routes. Each group uses people of its own: the per-account counters are real, and a
 * run of failures in one test must not become a wait in the next.
 */

let app: Awaited<ReturnType<typeof buildApp>>;
const DOMAIN = "@tf.test.local";
const PASSWORD = "Right-Pass-1234";

interface Person {
  id: string;
  email: string;
}

type Response = Awaited<ReturnType<typeof app.inject>>;

function cookieOf(res: Response): string | null {
  const header = res.headers["set-cookie"];
  const all = Array.isArray(header) ? header : header ? [String(header)] : [];
  const sid = all.find((c) => c.startsWith("sid="));
  return sid ? sid.split(";")[0] : null;
}

async function person(name: string, role: "user" | "admin" = "user"): Promise<Person> {
  const email = `${name}${DOMAIN}`;
  const user = await prisma.user.upsert({
    where: { email },
    update: { status: "active", role },
    create: {
      email,
      firstName: name[0].toUpperCase() + name.slice(1),
      lastName: "Tf",
      role,
      status: "active",
      passwordHash: await argon2.hash(PASSWORD),
    },
  });
  return { id: user.id, email };
}

const post = (url: string, payload: object, cookie?: string | null) =>
  app.inject({ method: "POST", url, payload, headers: cookie ? { cookie } : {} });
const get = (url: string, cookie?: string | null) =>
  app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });

/** The code the app would show `offset` steps from now. */
const codeFor = (secret: string, offset = 0) =>
  hotp(base32Decode(secret), stepAt(Date.now()) + offset);

/** A code that is certainly wrong: the right one, with its last digit turned. */
const wrongCode = (secret: string) => {
  const right = codeFor(secret);
  return right.slice(0, 5) + ((Number(right[5]) + 5) % 10);
};

/**
 * The single-use rule, set aside on purpose: a test that needs a third code inside one
 * thirty-second window has nothing else to use. Every test that checks the rule itself runs first.
 */
const forgetLastStep = (userId: string) =>
  prisma.twoFactorCredential.updateMany({ where: { userId }, data: { lastStep: null } });

async function sessionFor(email: string) {
  const res = await post("/api/auth/login", { email, password: PASSWORD });
  expect(res.statusCode, res.body).toBe(200);
  const cookie = cookieOf(res);
  expect(cookie).not.toBeNull();
  return cookie!;
}

/** Turns it on for `who`: the secret (unspaced), the ten codes, and the re-issued cookie. */
async function enrol(who: Person) {
  const cookie = await sessionFor(who.email);
  const setup = await post("/api/two-factor/me/setup", { password: PASSWORD }, cookie);
  expect(setup.statusCode, setup.body).toBe(200);
  const secret = String(setup.json().secret).replace(/ /g, "");
  const confirm = await post("/api/two-factor/me/confirm", { code: codeFor(secret) }, cookie);
  expect(confirm.statusCode, confirm.body).toBe(200);
  return {
    secret,
    recoveryCodes: confirm.json().recoveryCodes as string[],
    cookie: cookieOf(confirm)!,
  };
}

async function challengeFor(email: string): Promise<string> {
  const res = await post("/api/auth/login", { email, password: PASSWORD });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json()).toMatchObject({ twoFactorRequired: true });
  expect(cookieOf(res), "a challenge is not a session").toBeNull();
  return res.json().challenge as string;
}

const secondStep = (challenge: string, code: string) =>
  post("/api/auth/login/2fa", { challenge, code });

async function eventually<T>(read: () => Promise<T | null | undefined> | T | null | undefined) {
  for (let i = 0; i < 40; i++) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("never appeared");
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
const lettersTo = (to: string, since: number) =>
  testOutbox.slice(since).filter((m) => m.to === to);

async function eventFor(action: string, subjectId: string, since: Date) {
  return eventually(() =>
    prisma.activityEvent.findFirst({
      where: { action, subjectId, occurredAt: { gte: since } },
    }),
  );
}

async function cleanUp() {
  const ids = (
    await prisma.user.findMany({ where: { email: { endsWith: DOMAIN } }, select: { id: true } })
  ).map((u) => u.id);
  await prisma.signInThrottle.deleteMany({
    where: {
      OR: [{ key: { contains: DOMAIN } }, { key: { in: ids.map((id) => `2fa:${id}`) } }],
    },
  });
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  await prisma.firmProfile.updateMany({ data: { require2fa: "off", require2faSince: null } });
}

beforeAll(async () => {
  app = await buildApp();
  await prisma.firmProfile.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, name: "Two-factor test firm" },
  });
  await cleanUp();
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe("switching it on (§6.1)", () => {
  it("needs the password to begin, and switches nothing on until the app proves it has the secret", async () => {
    const who = await person("hesitant");
    const cookie = await sessionFor(who.email);

    const wrong = await post("/api/two-factor/me/setup", { password: "not-it" }, cookie);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.message).toMatch(/password is not right/);

    const setup = await post("/api/two-factor/me/setup", { password: PASSWORD }, cookie);
    expect(setup.statusCode).toBe(200);
    expect(setup.json().qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(setup.json().otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const secret = String(setup.json().secret).replace(/ /g, "");

    const mistyped = await post(
      "/api/two-factor/me/confirm",
      { code: wrongCode(secret) },
      cookie,
    );
    expect(mistyped.statusCode).toBe(400);

    // the day-one lockout, prevented by construction: an unconfirmed secret changes nothing
    expect((await get("/api/two-factor/me", cookie)).json()).toMatchObject({ enabled: false });
    expect(await sessionFor(who.email)).toBeTruthy();
  });

  it("turns on with a code, shows ten codes once, ends every other session and tells the owner", async () => {
    const who = await person("olena");
    const elsewhere = await sessionFor(who.email);
    const before = testOutbox.length;
    const since = new Date();

    const { cookie, recoveryCodes } = await enrol(who);
    expect(recoveryCodes).toHaveLength(10);

    // whoever already held a session does not keep it through the act meant to shut them out
    expect((await get("/api/auth/me", elsewhere)).statusCode).toBe(401);
    const me = await get("/api/auth/me", cookie);
    expect(me.statusCode).toBe(200);
    expect(me.json().twoFactor).toMatchObject({ enabled: true, mustEnrol: false });

    expect((await get("/api/two-factor/me", cookie)).json()).toMatchObject({
      enabled: true,
      recoveryCodesLeft: 10,
    });
    expect(lettersTo(who.email, before).map((m) => m.subject)).toEqual([
      expect.stringMatching(/Two-factor sign-in is on/),
    ]);
    await eventFor("user.two_factor_enabled", who.id, since);

    const again = await post("/api/two-factor/me/setup", { password: PASSWORD }, cookie);
    expect(again.statusCode, "a second setup must not replace a working secret").toBe(409);
  });
});

describe("signing in with it (§5)", () => {
  let who: Person;
  let secret: string;

  beforeAll(async () => {
    who = await person("petro");
    ({ secret } = await enrol(who));
  });

  it("answers the password with a challenge and no session, and the code with a session", async () => {
    const challenge = await challengeFor(who.email);
    const res = await secondStep(challenge, codeFor(secret, 1));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ email: who.email });
    expect((await get("/api/auth/me", cookieOf(res))).statusCode).toBe(200);
  });

  it("refuses a code that has already been used, inside its own window", async () => {
    const challenge = await challengeFor(who.email);
    const res = await secondStep(challenge, codeFor(secret, 1));
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatchObject({ code: "invalid_code" });
    expect(res.json().error.message).toMatch(/already been used/);
  });

  it("lets exactly one of two simultaneous submissions of the same code through", async () => {
    await forgetLastStep(who.id);
    const challenge = await challengeFor(who.email);
    const code = codeFor(secret);
    const before = await prisma.session.count({ where: { userId: who.id } });

    const results = await Promise.all([
      secondStep(challenge, code),
      secondStep(challenge, code),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    expect(await prisma.session.count({ where: { userId: who.id } })).toBe(before + 1);
  });

  it("refuses a fabricated or expired challenge, and a sixth try at the code", async () => {
    // the two refusals above were counted; this test is about the challenge's own five tries
    await prisma.signInThrottle.deleteMany({ where: { key: `2fa:${who.id}` } });
    const fabricated = await secondStep("not-a-real-challenge", codeFor(secret));
    expect(fabricated.statusCode).toBe(401);
    expect(fabricated.json().error.code).toBe("challenge_expired");

    const stale = await challengeFor(who.email);
    await prisma.twoFactorChallenge.updateMany({
      where: { credential: { userId: who.id }, usedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await secondStep(stale, codeFor(secret))).json().error.code).toBe(
      "challenge_expired",
    );

    const challenge = await challengeFor(who.email);
    for (let i = 0; i < 5; i++) {
      expect((await secondStep(challenge, wrongCode(secret))).json().error.code).toBe(
        "invalid_code",
      );
    }
    // the counter's wait is its own test; here only the challenge's five tries are under test
    await prisma.signInThrottle.updateMany({
      where: { key: `2fa:${who.id}` },
      data: { lastFailureAt: new Date(Date.now() - 120_000) },
    });
    await forgetLastStep(who.id);
    const sixth = await secondStep(challenge, codeFor(secret));
    expect(sixth.statusCode).toBe(401);
    expect(sixth.json().error.code, "five tries per password, then the password again").toBe(
      "challenge_expired",
    );
  });

  it("never gives a blocked account a challenge", async () => {
    await prisma.user.update({ where: { id: who.id }, data: { status: "blocked" } });
    const res = await post("/api/auth/login", { email: who.email, password: PASSWORD });
    expect(res.statusCode).toBe(401);
    expect(res.json().challenge).toBeUndefined();
    await prisma.user.update({ where: { id: who.id }, data: { status: "active" } });
  });

  it("keeps two-factor sign-in on through a password reset — a mailbox is not a second factor", async () => {
    const who2 = await person("forgetful");
    await enrol(who2);
    const before = testOutbox.length;
    await post("/api/auth/forgot-password", { email: who2.email });
    const letter = lettersTo(who2.email, before).find((m) => m.subject.includes("Reset"));
    const token = /token=([A-Za-z0-9_-]+)/.exec(letter!.html)![1];
    const reset = await post("/api/auth/reset-password", { token, password: PASSWORD });
    expect(reset.statusCode).toBe(200);
    await challengeFor(who2.email);
  });
});

describe("recovery codes (§6.2, §7)", () => {
  let who: Person;
  let secret: string;
  let codes: string[];
  let cookie: string;

  beforeAll(async () => {
    who = await person("mariya");
    ({ secret, recoveryCodes: codes, cookie } = await enrol(who));
  });

  it("signs somebody in once each, and tells the owner a code was used", async () => {
    const before = testOutbox.length;
    const since = new Date();
    const res = await secondStep(await challengeFor(who.email), codes[0].toUpperCase());
    expect(res.statusCode, res.body).toBe(200);
    cookie = cookieOf(res)!;

    expect(lettersTo(who.email, before).map((m) => m.subject)).toEqual([
      expect.stringMatching(/recovery code was used/),
    ]);
    const event = await eventFor("session.recovery_code_used", who.id, since);
    expect(event.changes).toEqual({ codesLeft: 9 });

    const reused = await secondStep(await challengeFor(who.email), codes[0]);
    expect(reused.statusCode).toBe(401);
    expect(reused.json().error.message).toMatch(/recovery code/);
  });

  it("needs the password for new ones, and the old ones stop working", async () => {
    const wrong = await post("/api/two-factor/me/recovery-codes", { password: "nope" }, cookie);
    expect(wrong.statusCode).toBe(400);

    const res = await post("/api/two-factor/me/recovery-codes", { password: PASSWORD }, cookie);
    expect(res.statusCode).toBe(200);
    const fresh = res.json().recoveryCodes as string[];
    expect(fresh).toHaveLength(10);

    expect((await secondStep(await challengeFor(who.email), codes[1])).statusCode).toBe(401);
    expect((await secondStep(await challengeFor(who.email), fresh[0])).statusCode).toBe(200);
    codes = fresh.slice(1);
  });

  /** §4.1: a restore paired with the wrong `.env` leaves every secret unreadable — not every door shut. */
  it("still lets somebody in with a recovery code when the secret cannot be opened", async () => {
    const credential = await prisma.twoFactorCredential.findUniqueOrThrow({
      where: { userId: who.id },
    });
    const tampered = Buffer.from(credential.ciphertext);
    tampered[0] ^= 0xff;
    await prisma.twoFactorCredential.update({
      where: { id: credential.id },
      data: { ciphertext: tampered },
    });

    const app1 = await secondStep(await challengeFor(who.email), codeFor(secret));
    expect(app1.statusCode).toBe(401);
    expect(app1.json().error.message).toMatch(/recovery codes/);

    expect((await secondStep(await challengeFor(who.email), codes[0])).statusCode).toBe(200);
  });
});

describe("switching it off (§6.3)", () => {
  it("needs a code as well as the password, ends the other sessions and tells the owner", async () => {
    const who = await person("ivan");
    const { secret, cookie } = await enrol(who);
    const elsewhere = cookieOf(
      await secondStep(await challengeFor(who.email), codeFor(secret, 1)),
    );
    const before = testOutbox.length;
    const since = new Date();

    const noCode = await post("/api/two-factor/me/disable", { password: PASSWORD }, cookie);
    expect(noCode.statusCode, "the password alone is what an attacker has").toBe(400);
    const wrong = await post(
      "/api/two-factor/me/disable",
      { password: PASSWORD, code: wrongCode(secret) },
      cookie,
    );
    expect(wrong.statusCode).toBe(400);

    await forgetLastStep(who.id);
    const off = await post(
      "/api/two-factor/me/disable",
      { password: PASSWORD, code: codeFor(secret) },
      cookie,
    );
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ enabled: false });
    expect((await get("/api/auth/me", elsewhere)).statusCode).toBe(401);
    expect((await get("/api/auth/me", cookieOf(off))).statusCode).toBe(200);
    expect(lettersTo(who.email, before).map((m) => m.subject)).toEqual([
      expect.stringMatching(/turned off/),
    ]);
    await eventFor("user.two_factor_disabled", who.id, since);

    // and signing in is one step again
    expect(await sessionFor(who.email)).toBeTruthy();
  });
});

describe("an admin's reset (§7)", () => {
  let admin: Person;
  let otherAdmin: Person;
  let adminCookie: string;

  beforeAll(async () => {
    admin = await person("boss", "admin");
    otherAdmin = await person("deputy", "admin");
    adminCookie = await sessionFor(admin.email);
  });

  it("is never available on the admin's own account, and needs the admin's own password", async () => {
    const self = await post(
      `/api/two-factor/users/${admin.id}/reset`,
      { password: PASSWORD },
      adminCookie,
    );
    expect(self.statusCode).toBe(400);
    expect(self.json().error.message).toMatch(/your profile/);

    const target = await person("wrongpass");
    await enrol(target);
    const wrong = await post(
      `/api/two-factor/users/${target.id}/reset`,
      { password: "not-the-admins" },
      adminCookie,
    );
    expect(wrong.statusCode).toBe(400);
    expect(await prisma.twoFactorCredential.count({ where: { userId: target.id } })).toBe(1);
  });

  it("clears the second factor, ends every session, and tells the owner and the other admins", async () => {
    const target = await person("taras");
    const { secret } = await enrol(target);
    await secondStep(await challengeFor(target.email), codeFor(secret, 1));
    expect(await prisma.session.count({ where: { userId: target.id } })).toBeGreaterThan(0);
    const before = testOutbox.length;
    const since = new Date();

    const res = await post(
      `/api/two-factor/users/${target.id}/reset`,
      { password: PASSWORD },
      adminCookie,
    );
    expect(res.statusCode, res.body).toBe(200);

    // asserted against the table, not the response
    expect(await prisma.session.count({ where: { userId: target.id } })).toBe(0);
    expect(await prisma.twoFactorCredential.count({ where: { userId: target.id } })).toBe(0);
    expect(lettersTo(target.email, before).map((m) => m.subject)).toEqual([
      expect.stringMatching(/was reset/),
    ]);
    const copy = await eventually(() => lettersTo(otherAdmin.email, before)[0]);
    expect(copy.text).toContain(target.email);
    await settle();
    expect(lettersTo(admin.email, before), "the admin who did it needs no letter").toEqual([]);
    const event = await eventFor("user.two_factor_reset", target.id, since);
    expect(event.actorUserId).toBe(admin.id);

    // their password alone signs them in now
    expect(await sessionFor(target.email)).toBeTruthy();
  });

  it("is Team's alone", async () => {
    const plain = await person("plainuser");
    const cookie = await sessionFor(plain.email);
    const res = await post(
      `/api/two-factor/users/${admin.id}/reset`,
      { password: PASSWORD },
      cookie,
    );
    expect(res.statusCode).toBe(403);
  });
});

describe("the counters on the second step (§9, §5.3)", () => {
  it("makes a run of wrong codes wait, and writes 'somebody knows your password' to the owner and the admins", async () => {
    const admin = await person("watcher", "admin");
    const who = await person("roman");
    const { secret } = await enrol(who);
    const before = testOutbox.length;

    let challenge = await challengeFor(who.email);
    for (let i = 0; i < 5; i++) {
      const res = await secondStep(challenge, wrongCode(secret));
      expect(res.statusCode).toBe(401);
    }
    challenge = await challengeFor(who.email);
    const waiting = await secondStep(challenge, codeFor(secret, 1));
    expect(waiting.statusCode, "the right code, too soon, waits like a wrong one").toBe(429);
    expect(Number(waiting.headers["retry-after"])).toBeGreaterThan(0);

    const own = await eventually(() => lettersTo(who.email, before)[0]);
    expect(own.subject).toMatch(/Somebody knows your/);
    const copy = await eventually(() => lettersTo(admin.email, before)[0]);
    expect(copy.subject).toMatch(/Somebody knows Roman/);

    const failed = await prisma.activityEvent.findFirst({
      where: { action: "session.second_factor_failed", subjectId: who.id },
    });
    expect(failed?.actorKind).toBe("system");
  });
});

describe("the firm's rule (§6.4)", () => {
  let admin: Person;
  let adminCookie: string;

  beforeAll(async () => {
    admin = await person("ruler", "admin");
    adminCookie = await sessionFor(admin.email);
  });

  afterAll(async () => {
    await prisma.firmProfile.updateMany({ data: { require2fa: "off", require2faSince: null } });
  });

  const backdate = (days: number) =>
    prisma.firmProfile.updateMany({
      data: { require2faSince: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
    });

  it("ships off, and is Team's to change", async () => {
    const overview = await get("/api/two-factor/team", adminCookie);
    expect(overview.json()).toMatchObject({ policy: "off", graceEndsAt: null });

    const plain = await person("bystander");
    const res = await app.inject({
      method: "PUT",
      url: "/api/two-factor/policy",
      payload: { policy: "everyone" },
      headers: { cookie: await sessionFor(plain.email) },
    });
    expect(res.statusCode).toBe(403);
  });

  it("gives a fortnight, then lets a person without it reach only their own row", async () => {
    const who = await person("nadia");
    const cookie = await sessionFor(who.email);
    const since = new Date();

    const changed = await app.inject({
      method: "PUT",
      url: "/api/two-factor/policy",
      payload: { policy: "everyone" },
      headers: { cookie: adminCookie },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().policy).toBe("everyone");
    const graceEnds = new Date(changed.json().graceEndsAt).getTime();
    expect(graceEnds).toBeGreaterThan(Date.now() + 13 * 24 * 60 * 60 * 1000);
    const event = await eventually(() =>
      prisma.activityEvent.findFirst({
        where: { action: "settings.two_factor_policy_changed", occurredAt: { gte: since } },
      }),
    );
    expect(event.changes).toEqual({ policy: { from: "Off", to: "Everyone" } });

    // inside the fortnight: everything as before, and the payload says what is coming
    expect((await get("/api/clients", cookie)).statusCode).not.toBe(403);
    expect((await get("/api/auth/me", cookie)).json().twoFactor).toMatchObject({
      required: true,
      mustEnrol: false,
    });

    // past it: the API refuses — not merely the screen
    await backdate(15);
    const refused = await get("/api/clients", cookie);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("two_factor_required");
    const me = await get("/api/auth/me", cookie);
    expect(me.statusCode, "who they are still answers").toBe(200);
    expect(me.json().twoFactor).toMatchObject({ mustEnrol: true });
    expect((await get("/api/two-factor/me", cookie)).statusCode).toBe(200);
    // …but their own tray and timer do not: they carry task and client names, which is firm data
    for (const url of ["/api/notifications", "/api/tasks/timer/active"]) {
      const own = await get(url, cookie);
      expect(own.statusCode, url).toBe(403);
      expect(own.json().error.code, url).toBe("two_factor_required");
    }

    // …which is where enrolment lives, and afterwards the door is open again
    const setup = await post("/api/two-factor/me/setup", { password: PASSWORD }, cookie);
    expect(setup.statusCode).toBe(200);
    const secret = String(setup.json().secret).replace(/ /g, "");
    const confirm = await post("/api/two-factor/me/confirm", { code: codeFor(secret) }, cookie);
    expect(confirm.statusCode).toBe(200);
    expect((await get("/api/clients", cookieOf(confirm))).statusCode).not.toBe(403);
  });

  it("covers only admins when set to admins", async () => {
    await prisma.firmProfile.updateMany({ data: { require2fa: "admins" } });
    await backdate(15);
    const plain = await person("staffer");
    expect((await get("/api/clients", await sessionFor(plain.email))).statusCode).not.toBe(403);
    const refused = await get("/api/clients", adminCookie);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("two_factor_required");
  });
});

describe("the Team overview (§3.1 — adoption must be visible)", () => {
  it("lists who has it on", async () => {
    const admin = await person("counter", "admin");
    const who = await person("adopter");
    await enrol(who);
    const res = await get("/api/two-factor/team", await sessionFor(admin.email));
    expect(res.statusCode).toBe(200);
    const ids = (res.json().members as Array<{ userId: string }>).map((m) => m.userId);
    expect(ids).toContain(who.id);
    expect(ids).not.toContain(admin.id);
  });
});

/**
 * A password re-asked on a signed-in screen — enrolment, new codes, switching it off, an admin's
 * reset — is a password guess like any other (audit, 2026-09-12): the same counter as the sign-in
 * form, and a run earns the same letter. The first version counted these and told nobody.
 */
describe("a password re-asked on a signed-in screen", () => {
  it("shares the sign-in form's counter, and a run of wrong ones writes to the owner", async () => {
    const who = await person("guessed");
    const cookie = await sessionFor(who.email);
    const before = testOutbox.length;

    for (let i = 0; i < 5; i++) {
      const res = await post("/api/two-factor/me/setup", { password: "not-it" }, cookie);
      expect(res.statusCode).toBe(400);
    }
    const waiting = await post("/api/two-factor/me/setup", { password: PASSWORD }, cookie);
    expect(waiting.statusCode, "the right password, too soon, waits like a wrong one").toBe(
      429,
    );

    const letter = await eventually(() => lettersTo(who.email, before)[0]);
    expect(letter.subject).toMatch(/Failed sign-ins on your/);

    // …and it is the same counter the sign-in form reads
    const atTheDoor = await post("/api/auth/login", { email: who.email, password: PASSWORD });
    expect(atTheDoor.statusCode).toBe(429);
  });
});

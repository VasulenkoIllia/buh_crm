import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { invalidateAccessCache } from "../../core/access.js";
import { prisma } from "../../core/db.js";
import { seal } from "../../core/secrets-crypto.js";
import * as repo from "./secrets.repository.js";
import { purgeTrash } from "./secrets.trash.js";
import { __clearGrants } from "./secrets.service.js";
import { TEST_UPLOADS_DIR } from "../../test/paths.js";

/**
 * The vault holds tax-portal and client-bank credentials, so these tests are about who can see
 * what, not about happy paths. Every one of them pins a rule that would be a leak if it broke.
 *
 * S18 moved the routes to `/api/secrets` and changed two rules: one unlock opens the whole vault
 * for the session (§6), and a delete goes to the Trash rather than being final (§9).
 */

/** The shape this tab has always sent, in the template that holds it since S18 (secrets.md §5). */
function freeForm(label: string, value?: string | null, extra: { description?: string } = {}) {
  return {
    template: "free_form" as const,
    label,
    ...extra,
    open: {},
    ...(value === undefined ? {} : { secret: value === null ? null : { value } }),
  };
}

/**
 * The activity log is flushed AFTER the response, so a test that reads it the moment `inject`
 * resolves is racing the flush. This waits for the row rather than sleeping a fixed time.
 */
async function loggedEvent(action: string, subjectId: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const row = await prisma.activityEvent.findFirst({
      where: { action, subjectId },
      select: { subjectLabel: true, changes: true, clientId: true },
    });
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no ${action} row for ${subjectId} was written`);
}

let app: Awaited<ReturnType<typeof buildApp>>;
let adminCookie: string;
let userCookie: string;
let clientId: string;
let otherClientId: string;

const PASSWORD = "password-123";

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

async function login(email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

beforeAll(async () => {
  app = await buildApp();
  await prisma.secretAuditLog.deleteMany();
  await prisma.secret.deleteMany();
  await prisma.session.deleteMany();
  await prisma.authToken.deleteMany();
  await prisma.client.deleteMany();
  await prisma.user.deleteMany();

  const hash = await argon2.hash(PASSWORD);
  await prisma.user.createMany({
    data: [
      {
        firstName: "Sec",
        lastName: "Admin",
        email: "sec-admin@test.local",
        passwordHash: hash,
        role: "admin",
        status: "active",
      },
      {
        firstName: "Sec",
        lastName: "User",
        email: "sec-user@test.local",
        passwordHash: hash,
        role: "user",
        status: "active",
      },
    ],
  });
  adminCookie = await login("sec-admin@test.local");
  userCookie = await login("sec-user@test.local");

  const mk = async (name: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie: adminCookie },
      payload: { firstName: name },
    });
    return res.json().id as string;
  };
  clientId = await mk("Secretful");
  otherClientId = await mk("Unrelated");
});

afterAll(async () => {
  await prisma.secretAuditLog.deleteMany();
  await prisma.secret.deleteMany();
  await prisma.client.deleteMany();
  await app.close();
});

describe("client secrets", () => {
  let secretId: string;

  it("stores a value encrypted — the row never holds the plaintext", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/secrets/clients/${clientId}`,
      headers: { cookie: adminCookie },
      payload: freeForm(
        "Кабінет платника податків",
        "login: 1234567890 / pass: super-secret-🔐",
        {
          description: "Логін і пароль до податкового кабінету",
        },
      ),
    });
    expect(res.statusCode).toBe(201);
    secretId = res.json()[0].id;

    const row = await prisma.secret.findUniqueOrThrow({ where: { id: secretId } });
    expect(row.ciphertext).not.toBeNull();
    // the plaintext must not survive anywhere in the row, in any encoding
    const blob = Buffer.concat([
      Buffer.from(row.ciphertext!),
      Buffer.from(row.label),
      Buffer.from(row.description ?? ""),
    ]).toString("utf8");
    expect(blob).not.toContain("super-secret");
    expect(blob).not.toContain("1234567890");
  });

  it("lists labels and descriptions but never the value or the ciphertext", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/secrets/clients/${clientId}`,
      headers: { cookie: userCookie }, // a regular colleague may see WHAT exists
    });
    expect(res.statusCode).toBe(200);
    const [entry] = res.json();
    expect(entry.label).toBe("Кабінет платника податків");
    expect(entry.hasValue).toBe(true);
    // the response shape carries no room for the secret at all
    expect(Object.keys(entry).sort()).toEqual(
      [
        "createdByName",
        "description",
        "fields",
        "hasValue",
        "id",
        "label",
        "movedFromName",
        "template",
        "updatedAt",
        "updatedByName",
        "files",
      ].sort(),
    );
    expect(JSON.stringify(res.json())).not.toContain("super-secret");
  });

  it("refuses to reveal without a grant, and a wrong password is journalled", async () => {
    __clearGrants();
    const cold = await app.inject({
      method: "POST",
      url: `/api/secrets/clients/${clientId}/${secretId}/reveal`,
      headers: { cookie: adminCookie },
    });
    expect(cold.statusCode).toBe(403);

    const wrong = await app.inject({
      method: "POST",
      url: `/api/secrets/unlock`,
      headers: { cookie: adminCookie },
      payload: { password: "not-my-password" },
    });
    expect(wrong.statusCode).toBe(403);
    // a run of these is the only way a guessing attempt becomes visible. The row carries no
    // client: an unlock opens the vault, not one list (§11)
    expect(
      await prisma.secretAuditLog.count({ where: { clientId: null, action: "unlock_failed" } }),
    ).toBe(1);
  });

  it("reveals after the right password, and writes exactly one audit row per reveal", async () => {
    const unlock = await app.inject({
      method: "POST",
      url: `/api/secrets/unlock`,
      headers: { cookie: adminCookie },
      payload: { password: PASSWORD },
    });
    expect(unlock.statusCode).toBe(200);
    expect(new Date(unlock.json().expiresAt).getTime()).toBeGreaterThan(Date.now());

    const before = await prisma.secretAuditLog.count({
      where: { clientId, action: "revealed" },
    });
    const reveal = await app.inject({
      method: "POST",
      url: `/api/secrets/clients/${clientId}/${secretId}/reveal`,
      headers: { cookie: adminCookie },
    });
    expect(reveal.statusCode).toBe(200);
    expect(reveal.json().secret.value).toBe("login: 1234567890 / pass: super-secret-🔐");
    expect(await prisma.secretAuditLog.count({ where: { clientId, action: "revealed" } })).toBe(
      before + 1,
    );
  });

  /**
   * **One unlock opens the whole vault** (decision 2, 2026-09-15), which reverses the grant per
   * client of 2026-08-01. With three places and a firm-wide search, a grant per client asked for
   * the password on every second click. What protects the value is the password step and the
   * journal, and both still hold: the reveal below is journalled like any other.
   */
  it("one unlock opens every client, not just the one it was typed on", async () => {
    // still unlocked from the previous test, and that unlock named no client at all
    const other = await app.inject({
      method: "POST",
      url: `/api/secrets/clients/${otherClientId}`,
      headers: { cookie: adminCookie },
      payload: freeForm("Bank", "other-client-secret"),
    });
    const otherSecretId = other.json()[0].id;

    const reveal = await app.inject({
      method: "POST",
      url: `/api/secrets/clients/${otherClientId}/${otherSecretId}/reveal`,
      headers: { cookie: adminCookie },
    });
    expect(reveal.statusCode).toBe(200);
    expect(reveal.json().secret.value).toBe("other-client-secret");
    expect(
      await prisma.secretAuditLog.count({
        where: { clientId: otherClientId, action: "revealed" },
      }),
    ).toBe(1);
  });

  it("keeps a pointer-only entry: no value stored, nothing to reveal", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/secrets/clients/${clientId}`,
      headers: { cookie: adminCookie },
      payload: freeForm("КЕП директора", null, {
        description: "Занадто чутливе — лежить у менеджері паролів, запис «Kvitka КЕП»",
      }),
    });
    expect(res.statusCode).toBe(201);
    const pointer = res.json().find((s: { label: string }) => s.label === "КЕП директора");
    expect(pointer.hasValue).toBe(false);

    const row = await prisma.secret.findUniqueOrThrow({ where: { id: pointer.id } });
    expect(row.ciphertext).toBeNull();
    expect(row.iv).toBeNull();
    expect(row.authTag).toBeNull();

    const reveal = await app.inject({
      method: "POST",
      url: `/api/secrets/clients/${clientId}/${pointer.id}/reveal`,
      headers: { cookie: adminCookie },
    });
    expect(reveal.statusCode).toBe(400); // there is nothing to reveal, and it says so
  });

  // The form now sends the field's contents verbatim, so "cleared the box" must mean "store
  // nothing" — the same rule as creating (user, 2026-08-03).
  it("an edit with an empty value clears it, keeping the entry as a reference", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/secrets/clients/${clientId}/${secretId}`,
      headers: { cookie: adminCookie },
      payload: freeForm("Кабінет платника податків", null),
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.secret.findUniqueOrThrow({ where: { id: secretId } });
    expect(row.ciphertext).toBeNull();
  });

  /**
   * Deleting cost the viewer's password until 2026-09-15, because it was final. It is not final any
   * more: the secret waits thirty days in the Trash, and being undoable is what that password was
   * standing in for (decision 4).
   */
  it("a delete needs no password and goes to the Trash", async () => {
    __clearGrants();
    const created = await app.inject({
      method: "POST",
      url: `/api/secrets/clients/${clientId}`,
      headers: { cookie: adminCookie },
      payload: freeForm("Old portal", "v"),
    });
    const doomed = created.json().find((s: { label: string }) => s.label === "Old portal");

    const res = await app.inject({
      method: "DELETE",
      url: `/api/secrets/clients/${clientId}/${doomed.id}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    // gone from the list at once, and the answer names the gesture an Undo would take back
    expect(res.json().items.some((s: { id: string }) => s.id === doomed.id)).toBe(false);
    expect(res.json().batchId).toEqual(expect.any(String));
    // …and in the Trash as ONE gesture: the three columns are set together, which the database
    // also refuses to have broken
    const row = await prisma.secret.findUniqueOrThrow({ where: { id: doomed.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedById).not.toBeNull();
    expect(row.trashBatchId).not.toBeNull();

    // the window is open again for the rest of the file
    await app.inject({
      method: "POST",
      url: `/api/secrets/unlock`,
      headers: { cookie: adminCookie },
      payload: { password: PASSWORD },
    });
  });

  it("collapses repeat looks and pages the log", async () => {
    // reveal the same secret several times in a row — the edit form does this too
    for (let i = 0; i < 4; i++) {
      await app.inject({
        method: "POST",
        url: `/api/secrets/clients/${clientId}/${secretId}/reveal`,
        headers: { cookie: adminCookie },
      });
    }
    // one row per LOOK, not per click
    const reveals = await prisma.secretAuditLog.count({
      where: { clientId, secretId, action: "revealed" },
    });
    expect(reveals).toBe(1);

    const first = await app.inject({
      method: "GET",
      url: `/api/secrets/clients/${clientId}/audit`,
      headers: { cookie: adminCookie },
    });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(10);
    expect(body.items.length).toBeLessThanOrEqual(10);
    expect(body.total).toBeGreaterThan(0);

    // a page past the end answers empty rather than erroring — the modal can ask for it
    const far = await app.inject({
      method: "GET",
      url: `/api/secrets/clients/${clientId}/audit?page=99`,
      headers: { cookie: adminCookie },
    });
    expect(far.statusCode).toBe(200);
    expect(far.json().items).toHaveLength(0);
  });

  it("the log still says WHAT it was about after the secret is gone", async () => {
    // the FK goes null when the Trash is purged, so the name is snapshotted onto the row when it
    // is written — a log that cannot say what it was about is not worth keeping (user, 2026-08-03)
    const rows = await prisma.secretAuditLog.findMany({
      where: { clientId, action: "revealed" },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.label !== null)).toBe(true);
  });

  it("the audit trail survives the secret it describes", async () => {
    const before = await prisma.secretAuditLog.count({ where: { clientId } });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/secrets/clients/${clientId}/${secretId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    // the row is not destroyed now, it is in the Trash; the journal is kept either way, and stays
    // when the nightly purge does destroy it
    const row = await prisma.secret.findUniqueOrThrow({ where: { id: secretId } });
    expect(row.deletedAt).not.toBeNull();
    expect(await prisma.secretAuditLog.count({ where: { clientId } })).toBeGreaterThan(before);
  });

  /**
   * Secrets were admin-only until 2026-08-14. The ROLE went; the password did not.
   *
   * Both halves are here on purpose. A rule half the team has to ask an admin about is a rule they
   * route around, by keeping the login somewhere worse — so an ordinary user must be able to do
   * the work. But a user with a session is not a user who just typed their password, and the
   * second test is what stops "any signed-in user" quietly becoming "anyone at an unlocked laptop".
   *
   * Self-contained: it makes and removes its own secret rather than borrowing the shared one,
   * which by this point in the file has already been deleted by the audit-trail test.
   */
  it("lets an ordinary user write, unlock and reveal", async () => {
    __clearGrants();

    const created = await app.inject({
      method: "POST",
      url: `/api/secrets/clients/${clientId}`,
      headers: { cookie: userCookie },
      payload: freeForm("Theirs", "user-written-value"),
    });
    expect(created.statusCode).toBe(201);
    const mine = created.json().find((x: { label: string }) => x.label === "Theirs");

    const unlock = await app.inject({
      method: "POST",
      url: `/api/secrets/unlock`,
      headers: { cookie: userCookie },
      payload: { password: PASSWORD },
    });
    expect(unlock.statusCode).toBe(200);

    const reveal = await app.inject({
      method: "POST",
      url: `/api/secrets/clients/${clientId}/${mine.id}/reveal`,
      headers: { cookie: userCookie },
    });
    expect(reveal.statusCode).toBe(200);
    expect(reveal.json().secret.value).toBe("user-written-value");

    // journalled under their own name — the log names a person, never a role
    const audit = await app.inject({
      method: "GET",
      url: `/api/secrets/clients/${clientId}/audit`,
      headers: { cookie: userCookie },
    });
    expect(audit.json().items.some((r: { byName: string }) => r.byName === "Sec User")).toBe(
      true,
    );

    const drop = await app.inject({
      method: "DELETE",
      url: `/api/secrets/clients/${clientId}/${mine.id}`,
      headers: { cookie: userCookie },
    });
    expect(drop.statusCode).toBe(200);
  });

  it("still refuses an ordinary user who has not entered their password", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/secrets/clients/${clientId}`,
      headers: { cookie: userCookie },
      payload: freeForm("Locked", "v"),
    });
    const mine = created.json().find((x: { label: string }) => x.label === "Locked");
    __clearGrants();

    const reveal = await app.inject({
      method: "POST",
      url: `/api/secrets/clients/${clientId}/${mine.id}/reveal`,
      headers: { cookie: userCookie },
    });
    expect(reveal.statusCode).toBe(403);

    const wrong = await app.inject({
      method: "POST",
      url: `/api/secrets/unlock`,
      headers: { cookie: userCookie },
      payload: { password: "not-their-password" },
    });
    expect(wrong.statusCode).toBe(403);
  });
});

/**
 * **The templates** (secrets.md §5, §18). Each one decides its own fields, and the rules here are
 * the ones that catch a mistyped credential before it is stored: an IP PIN is six digits, a routing
 * number nine, a card number passes its own check digit, and a CVV is as long as its brand says.
 *
 * A card PIN has no field to be put in, in any template, and that is the point of a strict shape.
 */
describe("the eight templates", () => {
  const post = (payload: unknown) =>
    app.inject({
      method: "POST",
      url: `/api/secrets/clients/${clientId}`,
      headers: { cookie: adminCookie },
      payload: payload as Record<string, unknown>,
    });
  type Made = {
    id: string;
    label: string;
    fields: Record<string, string>;
    hasValue: boolean;
  };
  const made = (res: { json(): Made[] }, label: string) =>
    res.json().find((s) => s.label === label)!;

  beforeAll(async () => {
    __clearGrants();
    await app.inject({
      method: "POST",
      url: "/api/secrets/unlock",
      headers: { cookie: adminCookie },
      payload: { password: PASSWORD },
    });
  });

  it("keeps each template to its own fields, and refuses one it does not declare", async () => {
    const login = await post({
      template: "login",
      label: "Gusto payroll",
      open: { site: "gusto.com" },
      secret: { login: "payroll@firm.example", password: "Gs9!aP4w#Xe7Lm2q" },
    });
    expect(login.statusCode).toBe(201);
    expect(made(login, "Gusto payroll").fields).toEqual({ site: "gusto.com" });

    // an agency belongs to a tax account, not to a login
    const strayOpen = await post({
      template: "login",
      label: "Wrong",
      open: { agency: "EFTPS" },
      secret: {},
    });
    expect(strayOpen.statusCode).toBe(400);

    // **a card PIN has nowhere to go** (§5.3): the shape refuses the field itself
    const cardPin = await post({
      template: "payment_card",
      label: "Card with a PIN",
      open: {},
      secret: { number: "4111111111111111", pin: "1234" },
    });
    expect(cardPin.statusCode).toBe(400);
  });

  it("refuses the numbers people mistype", async () => {
    const shortPin = await post({
      template: "ip_pin",
      label: "IP PIN 2026",
      open: { year: "2026", who: "taxpayer" },
      secret: { pin: "12345" },
    });
    expect(shortPin.statusCode).toBe(400);

    const shortRouting = await post({
      template: "bank",
      label: "Bad routing",
      open: { bank: "Chase" },
      secret: { routing: "12345678" },
    });
    expect(shortRouting.statusCode).toBe(400);

    const badCard = await post({
      template: "payment_card",
      label: "Mistyped card",
      open: {},
      secret: { number: "4111111111111112" },
    });
    expect(badCard.statusCode).toBe(400);

    // a state tax account must say WHICH state, or its own list cannot be read
    const nameless = await post({
      template: "tax_account",
      label: "State",
      open: { agency: "State tax department" },
      secret: {},
    });
    expect(nameless.statusCode).toBe(400);
  });

  it("computes a card's brand and last four, and holds the CVV to the brand", async () => {
    const visa = await post({
      template: "payment_card",
      label: "Firm Visa",
      open: {},
      secret: {
        number: "4111 1111 1111 1111",
        holder: "IRYNA BONDAR",
        expiry: "11/29",
        cvv: "318",
      },
    });
    expect(visa.statusCode).toBe(201);
    // the only digits a list ever shows
    expect(made(visa, "Firm Visa").fields).toEqual({ brand: "Visa", last4: "1111" });

    const amexThree = await post({
      template: "payment_card",
      label: "Firm Amex",
      open: {},
      secret: { number: "378282246310005", cvv: "421" },
    });
    expect(amexThree.statusCode).toBe(400);

    const amex = await post({
      template: "payment_card",
      label: "Firm Amex",
      open: {},
      secret: { number: "378282246310005", cvv: "4421" },
    });
    expect(amex.statusCode).toBe(201);
    expect(made(amex, "Firm Amex").fields.brand).toBe("American Express");
  });

  it("opens every secret field of an entry at once, and shows none of them in a list", async () => {
    const created = await post({
      template: "tax_account",
      label: "EFTPS, firm enrollment",
      description: "Iryna is the responsible official",
      open: { agency: "EFTPS" },
      secret: { idNumber: "EIN 84-1234567", pin: "4418", password: "Ew5#nB8q!Tz2" },
    });
    expect(created.statusCode).toBe(201);
    const row = made(created, "EFTPS, firm enrollment");
    expect(row.fields).toEqual({ agency: "EFTPS" });
    expect(JSON.stringify(created.json())).not.toContain("Ew5#nB8q");

    const reveal = await app.inject({
      method: "POST",
      url: `/api/secrets/clients/${clientId}/${row.id}/reveal`,
      headers: { cookie: adminCookie },
    });
    expect(reveal.statusCode).toBe(200);
    expect(reveal.json().secret).toEqual({
      idNumber: "EIN 84-1234567",
      pin: "4418",
      password: "Ew5#nB8q!Tz2",
    });

    // the search reads the open words and never the sealed ones (§10)
    const stored = await prisma.secret.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.searchText).toContain("eftps");
    expect(stored.searchText).not.toContain("ew5");
    expect(stored.searchText).not.toContain("84-1234567");
  });

  it("takes a pointer-only entry in any template, and refuses to change a template", async () => {
    const pointer = await post({
      template: "bank",
      label: "Payroll account",
      description: "Andrii keeps the login himself. Ask him by phone.",
      open: { bank: "Wells Fargo" },
    });
    expect(pointer.statusCode).toBe(201);
    const row = made(pointer, "Payroll account");
    expect(row).toMatchObject({ hasValue: false, fields: { bank: "Wells Fargo" } });

    const swapped = await app.inject({
      method: "PATCH",
      url: `/api/secrets/clients/${clientId}/${row.id}`,
      headers: { cookie: adminCookie },
      payload: {
        template: "login",
        label: "Payroll account",
        open: { site: "wellsfargo.com" },
      },
    });
    expect(swapped.statusCode).toBe(400);
    // refused by the rule, not by the shape: the body says so in words
    expect(swapped.body).toContain("cannot be changed");
  });

  it("still opens a free-form row written before the templates existed", async () => {
    // exactly what the S18 migration left behind: the plain string S7.5 sealed, and the defaults
    const sealed = seal("login olena.p / pass Summer2024!");
    const legacy = await prisma.secret.create({
      data: {
        space: "client",
        clientId,
        label: "Tax portal login",
        searchText: "tax portal login",
        ciphertext: Buffer.from(sealed.ciphertext),
        iv: Buffer.from(sealed.iv),
        authTag: Buffer.from(sealed.authTag),
        keyVersion: sealed.keyVersion,
      },
      select: { id: true, template: true },
    });
    expect(legacy.template).toBe("free_form");

    const reveal = await app.inject({
      method: "POST",
      url: `/api/secrets/clients/${clientId}/${legacy.id}/reveal`,
      headers: { cookie: adminCookie },
    });
    expect(reveal.statusCode).toBe(200);
    expect(reveal.json().secret).toEqual({ value: "login olena.p / pass Summer2024!" });
  });
});

/**
 * **The three places** (secrets.md §4.2, §18). My secrets is one list per person, private from
 * colleagues and admins alike; Company is the firm's own, open to anyone with Secrets; a client's
 * list needs Clients open as well, because a client's name is client data whichever screen it is on.
 */
describe("my secrets, Company, and a client's list", () => {
  const userId = async (email: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id;

  async function setGate(email: string, gate: "clients" | "secrets", state: "open" | "closed") {
    await prisma.accessOverride.upsert({
      where: { userId_gate_action: { userId: await userId(email), gate, action: "*" } },
      update: { state },
      create: { userId: await userId(email), gate, state },
    });
    invalidateAccessCache();
  }

  beforeAll(async () => {
    __clearGrants();
    for (const cookie of [adminCookie, userCookie]) {
      await app.inject({
        method: "POST",
        url: "/api/secrets/unlock",
        headers: { cookie },
        payload: { password: PASSWORD },
      });
    }
  });

  it("keeps My secrets to the person whose they are", async () => {
    const mine = await app.inject({
      method: "POST",
      url: "/api/secrets/my",
      headers: { cookie: adminCookie },
      payload: freeForm("NATP member login", "m.shevchuk / Vq8!rT2m"),
    });
    expect(mine.statusCode).toBe(201);
    const id = mine.json()[0].id as string;

    // the colleague's own list is empty, and theirs does not appear in it
    const theirs = await app.inject({
      method: "GET",
      url: "/api/secrets/my",
      headers: { cookie: userCookie },
    });
    expect(theirs.json()).toEqual([]);

    // and it cannot be read by naming it: the place is part of the lookup, not a filter on top
    const reveal = await app.inject({
      method: "POST",
      url: `/api/secrets/my/${id}/reveal`,
      headers: { cookie: userCookie },
    });
    expect(reveal.statusCode).toBe(404);

    // the log names the act and never the title (§11)
    expect((await loggedEvent("secret.created", id)).subjectLabel).toBe("a personal secret");
  });

  it("gives Company to everyone with Secrets", async () => {
    const made = await app.inject({
      method: "POST",
      url: "/api/secrets/company",
      headers: { cookie: adminCookie },
      payload: {
        template: "device",
        label: "Office Wi-Fi",
        open: { device: "FIRM-Office-5G" },
        secret: { password: "meadow-copper-42-lantern" },
      },
    });
    expect(made.statusCode).toBe(201);
    const id = made.json().find((s: { label: string }) => s.label === "Office Wi-Fi")!
      .id as string;

    const seen = await app.inject({
      method: "GET",
      url: "/api/secrets/company",
      headers: { cookie: userCookie },
    });
    expect(seen.json().map((s: { label: string }) => s.label)).toContain("Office Wi-Fi");

    const reveal = await app.inject({
      method: "POST",
      url: `/api/secrets/company/${id}/reveal`,
      headers: { cookie: userCookie },
    });
    expect(reveal.statusCode).toBe(200);
    expect(reveal.json().secret).toEqual({ password: "meadow-copper-42-lantern" });
  });

  it("needs Clients open for a client's list, and leaves the other two places alone", async () => {
    await setGate("sec-user@test.local", "clients", "closed");
    try {
      const list = await app.inject({
        method: "GET",
        url: `/api/secrets/clients/${clientId}`,
        headers: { cookie: userCookie },
      });
      expect(list.statusCode).toBe(403);

      // Company and My secrets are not a client's, and stay where they were
      const company = await app.inject({
        method: "GET",
        url: "/api/secrets/company",
        headers: { cookie: userCookie },
      });
      expect(company.statusCode).toBe(200);
    } finally {
      await setGate("sec-user@test.local", "clients", "open");
    }
  });
});

/**
 * **Moves** (secrets.md §7). Out of My secrets or Company anybody with Secrets may move; out of a
 * CLIENT only an admin, through a route that says so in its declaration. The ciphertext never
 * moves: the key is the same in every place.
 */
describe("moving a secret between places", () => {
  beforeAll(async () => {
    __clearGrants();
    await app.inject({
      method: "POST",
      url: "/api/secrets/unlock",
      headers: { cookie: adminCookie },
      payload: { password: PASSWORD },
    });
  });

  it("shares one of My secrets with the firm, and says so in both places' words", async () => {
    const made = await app.inject({
      method: "POST",
      url: "/api/secrets/my",
      headers: { cookie: adminCookie },
      payload: freeForm("Drake Tax", "oksana.l / Dr8#kE3w"),
    });
    const id = made.json().find((s: { label: string }) => s.label === "Drake Tax")!
      .id as string;

    const moved = await app.inject({
      method: "POST",
      url: "/api/secrets/my/move",
      headers: { cookie: adminCookie },
      payload: { ids: [id], to: { space: "company" } },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ moved: 1, to: "Company" });

    const row = await prisma.secret.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ space: "company", ownerId: null, clientId: null });

    const event = await loggedEvent("secret.moved", id);
    // the title travels with it: the non-personal end decides what the log may say (§11)
    expect(event.subjectLabel).toBe("Drake Tax");
    expect(event.changes).toMatchObject({ from: "My secrets", to: "Company" });

    // and the value still opens, because nothing was re-encrypted
    const reveal = await app.inject({
      method: "POST",
      url: `/api/secrets/company/${id}/reveal`,
      headers: { cookie: adminCookie },
    });
    expect(reveal.json().secret).toEqual({ value: "oksana.l / Dr8#kE3w" });
  });

  it("cannot reach a colleague's My secrets by naming one", async () => {
    const theirs = await app.inject({
      method: "POST",
      url: "/api/secrets/my",
      headers: { cookie: userCookie },
      payload: freeForm("Their own", "v"),
    });
    const id = theirs.json().find((s: { label: string }) => s.label === "Their own")!
      .id as string;

    // the admin's own My secrets is the source, and that secret is not in it
    const stolen = await app.inject({
      method: "POST",
      url: "/api/secrets/my/move",
      headers: { cookie: adminCookie },
      payload: { ids: [id], to: { space: "company" } },
    });
    expect(stolen.statusCode).toBe(404);
    expect((await prisma.secret.findUniqueOrThrow({ where: { id } })).space).toBe("personal");
  });

  it("lets only an admin move a secret out of a client, and keeps that move long", async () => {
    const made = await app.inject({
      method: "POST",
      url: `/api/secrets/clients/${clientId}`,
      headers: { cookie: adminCookie },
      payload: freeForm("Filed under the wrong client", "v"),
    });
    const id = made
      .json()
      .find((s: { label: string }) => s.label === "Filed under the wrong client")!.id as string;

    const refused = await app.inject({
      method: "POST",
      url: `/api/secrets/clients/${clientId}/move-out`,
      headers: { cookie: userCookie },
      payload: { ids: [id], to: { space: "company" } },
    });
    expect(refused.statusCode).toBe(403);

    const done = await app.inject({
      method: "POST",
      url: `/api/secrets/clients/${clientId}/move-out`,
      headers: { cookie: adminCookie },
      payload: { ids: [id], to: { space: "company" } },
    });
    expect(done.statusCode).toBe(200);

    const event = await loggedEvent("secret.refiled", id);
    expect(event.changes).toMatchObject({ from: "Clients › Secretful", to: "Company" });
  });
});

/**
 * The same six acts in the two fixed places, so every changing route describes itself at least once
 * (`npm run check:activity-routes`). The rules they follow are proven above; this walks them.
 */
describe("editing and deleting in My secrets and Company", () => {
  const post = (url: string, payload: unknown) =>
    app.inject({
      method: "POST",
      url,
      headers: { cookie: adminCookie },
      payload: payload as Record<string, unknown>,
    });
  const labelled = (res: { json(): { id: string; label: string }[] }, label: string) =>
    res.json().find((s) => s.label === label)!.id;

  beforeAll(async () => {
    __clearGrants();
    await post("/api/secrets/unlock", { password: PASSWORD });
  });

  it("walks My secrets: save, edit, reveal, delete", async () => {
    const made = await post("/api/secrets/my", freeForm("CPE portal", "marta.s / 7Fg!pL0q"));
    expect(made.statusCode).toBe(201);
    const id = labelled(made, "CPE portal");

    const edited = await app.inject({
      method: "PATCH",
      url: `/api/secrets/my/${id}`,
      headers: { cookie: adminCookie },
      payload: freeForm("CPE portal", "marta.s / rotated-4Kq!", { description: "myCPE" }),
    });
    expect(edited.statusCode).toBe(200);

    const reveal = await post(`/api/secrets/my/${id}/reveal`, undefined);
    expect(reveal.json().secret).toEqual({ value: "marta.s / rotated-4Kq!" });

    const gone = await app.inject({
      method: "DELETE",
      url: `/api/secrets/my/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(gone.statusCode).toBe(200);
    expect((await prisma.secret.findUniqueOrThrow({ where: { id } })).deletedAt).not.toBeNull();
  });

  it("walks Company: save, edit, move into My secrets, delete", async () => {
    const made = await post(
      "/api/secrets/company",
      freeForm("Brother printer", "admin / Pr1nt!Adm#9"),
    );
    const id = labelled(made, "Brother printer");

    const edited = await app.inject({
      method: "PATCH",
      url: `/api/secrets/company/${id}`,
      headers: { cookie: adminCookie },
      payload: freeForm("Brother printer", "admin / Pr1nt!Adm#9", {
        description: "Admin page at 192.168.1.40",
      }),
    });
    expect(edited.statusCode).toBe(200);

    // a second one, deleted where it stands, so Company's own delete is walked too
    const kept = await post("/api/secrets/company", freeForm("Old office Wi-Fi", "v"));
    const keptId = labelled(kept, "Old office Wi-Fi");
    const trashed = await app.inject({
      method: "DELETE",
      url: `/api/secrets/company/${keptId}`,
      headers: { cookie: adminCookie },
    });
    expect(trashed.statusCode).toBe(200);

    const moved = await post("/api/secrets/company/move", {
      ids: [id],
      to: { space: "personal" },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ moved: 1, to: "My secrets" });

    const gone = await app.inject({
      method: "DELETE",
      url: `/api/secrets/my/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(gone.statusCode).toBe(200);
  });
});

/**
 * **The Trash** (secrets.md §9). A delete is one gesture, undone as one; each item shows by the rule
 * of the place it came from; and thirty days later the nightly job removes it for good and records
 * that it did, which is the firm's disposal evidence.
 */
describe("the Trash and its nightly purge", () => {
  const post = (url: string, payload?: unknown, cookie = adminCookie) =>
    app.inject({
      method: "POST",
      url,
      headers: { cookie },
      payload: payload as Record<string, unknown>,
    });
  const drop = (url: string, cookie = adminCookie) =>
    app.inject({ method: "DELETE", url, headers: { cookie } });
  const trashOf = async (cookie: string) =>
    (await app.inject({ method: "GET", url: "/api/secrets/trash", headers: { cookie } })).json()
      .batches as {
      batchId: string;
      deletedBy: string;
      daysLeft: number;
      items: { id: string; label: string; place: string }[];
    }[];

  it("lists a delete as one gesture, with its place and the days left", async () => {
    const made = await post(
      `/api/secrets/clients/${clientId}`,
      freeForm("Old bank login", "v"),
    );
    const id = made.json().find((s: { label: string }) => s.label === "Old bank login")!
      .id as string;
    const deleted = await drop(`/api/secrets/clients/${clientId}/${id}`);
    const batchId = deleted.json().batchId as string;

    const batch = (await trashOf(adminCookie)).find((b) => b.batchId === batchId)!;
    expect(batch.deletedBy).toBe("Sec Admin");
    expect(batch.daysLeft).toBe(30);
    expect(batch.items).toEqual([
      { id, label: "Old bank login", template: "free_form", place: "Clients › Secretful" },
    ]);
  });

  it("restores a whole gesture, and one secret out of another", async () => {
    const first = await post("/api/secrets/company", freeForm("Undo me", "v"));
    const firstId = first.json().find((s: { label: string }) => s.label === "Undo me")!
      .id as string;
    const batchId = (await drop(`/api/secrets/company/${firstId}`)).json().batchId as string;

    const back = await post(`/api/secrets/trash/batches/${batchId}/restore`);
    expect(back.statusCode).toBe(200);
    expect(back.json()).toEqual({ restored: 1 });
    expect(
      (await prisma.secret.findUniqueOrThrow({ where: { id: firstId } })).deletedAt,
    ).toBeNull();

    // and one item on its own
    const second = await post("/api/secrets/company", freeForm("One of several", "v"));
    const secondId = second.json().find((s: { label: string }) => s.label === "One of several")!
      .id as string;
    await drop(`/api/secrets/company/${secondId}`);
    const one = await post(`/api/secrets/trash/secrets/${secondId}/restore`);
    expect(one.json()).toEqual({ restored: 1 });
    expect(
      (await prisma.secret.findUniqueOrThrow({ where: { id: secondId } })).trashBatchId,
    ).toBeNull();
  });

  it("deletes a selection as ONE gesture, and one Undo brings every secret back", async () => {
    const labels = ["Batch one", "Batch two", "Batch three"];
    for (const label of labels) await post("/api/secrets/company", freeForm(label, "v"));
    const ids = (
      await prisma.secret.findMany({
        where: { label: { in: labels } },
        select: { id: true },
      })
    ).map((s) => s.id);

    const deleted = await post("/api/secrets/company/delete", { ids });
    expect(deleted.statusCode).toBe(200);
    const { deleted: count, batchId } = deleted.json() as { deleted: number; batchId: string };
    expect(count).toBe(3);

    // one gesture in the Trash, all three in it
    const batch = (await trashOf(adminCookie)).find((b) => b.batchId === batchId)!;
    expect(batch.items.map((i) => i.label).sort()).toEqual([...labels].sort());
    expect((await loggedEvent("secret.deleted", ids[0])).subjectLabel).toMatch(/^Batch /);

    const back = await post(`/api/secrets/trash/batches/${batchId}/restore`);
    expect(back.json()).toEqual({ restored: 3 });
    const rows = await prisma.secret.findMany({ where: { id: { in: ids } } });
    expect(rows.every((r) => r.deletedAt === null && r.trashBatchId === null)).toBe(true);
  });

  it("deletes nothing when a selection names a secret from another place, or one twice", async () => {
    await post(`/api/secrets/clients/${clientId}`, freeForm("Client batch", "v"));
    await post(`/api/secrets/clients/${clientId}`, freeForm("Client batch two", "v"));
    const [here, alsoHere] = (
      await prisma.secret.findMany({
        where: { label: { in: ["Client batch", "Client batch two"] } },
        select: { id: true },
        orderBy: { label: "asc" },
      })
    ).map((s) => s.id);
    await post("/api/secrets/company", freeForm("Elsewhere", "v"));
    const elsewhere = (await prisma.secret.findFirstOrThrow({ where: { label: "Elsewhere" } }))
      .id;

    const mixed = await post(`/api/secrets/clients/${clientId}/delete`, {
      ids: [here, elsewhere],
    });
    expect(mixed.statusCode).toBe(404);
    const twice = await post(`/api/secrets/clients/${clientId}/delete`, { ids: [here, here] });
    expect(twice.statusCode).toBe(400);
    expect(
      await prisma.secret.count({
        where: { id: { in: [here, elsewhere] }, deletedAt: { not: null } },
      }),
    ).toBe(0);

    // the same two from their own client go, together
    const fine = await post(`/api/secrets/clients/${clientId}/delete`, {
      ids: [here, alsoHere],
    });
    expect(fine.json().deleted).toBe(2);
    expect((await loggedEvent("secret.deleted", here)).clientId).toBe(clientId);

    // and My secrets takes a selection the same way, only from its owner's own list
    await post("/api/secrets/my", freeForm("Mine in a batch", "v"), userCookie);
    const mine = (await prisma.secret.findFirstOrThrow({ where: { label: "Mine in a batch" } }))
      .id;
    const notTheirs = await post("/api/secrets/my/delete", { ids: [mine] });
    expect(notTheirs.statusCode).toBe(404);
    const own = await post("/api/secrets/my/delete", { ids: [mine] }, userCookie);
    expect(own.json().deleted).toBe(1);
  });

  it("keeps a colleague's deleted My secrets out of everybody else's Trash", async () => {
    const theirs = await post(
      "/api/secrets/my",
      freeForm("Their own, deleted", "v"),
      userCookie,
    );
    const id = theirs.json().find((s: { label: string }) => s.label === "Their own, deleted")!
      .id as string;
    const batchId = (await drop(`/api/secrets/my/${id}`, userCookie)).json().batchId as string;

    // its owner sees it…
    expect((await trashOf(userCookie)).some((b) => b.batchId === batchId)).toBe(true);
    // …and the admin does not, in a Trash that shows everything else
    expect((await trashOf(adminCookie)).some((b) => b.batchId === batchId)).toBe(false);

    const stolen = await post(`/api/secrets/trash/batches/${batchId}/restore`);
    expect(stolen.statusCode).toBe(404);
  });

  it("removes for good what is past thirty days, and records the disposal", async () => {
    const made = await post(`/api/secrets/clients/${clientId}`, freeForm("Long gone", "v"));
    const id = made.json().find((s: { label: string }) => s.label === "Long gone")!
      .id as string;
    await drop(`/api/secrets/clients/${clientId}/${id}`);

    // a young one stays behind, which is what makes the cutoff a cutoff
    const young = await post(
      `/api/secrets/clients/${clientId}`,
      freeForm("Deleted today", "v"),
    );
    const youngId = young.json().find((s: { label: string }) => s.label === "Deleted today")!
      .id as string;
    await drop(`/api/secrets/clients/${clientId}/${youngId}`);

    await prisma.secret.update({
      where: { id },
      data: { deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
    });
    const journalBefore = await prisma.secretAuditLog.count({ where: { secretId: id } });
    expect(journalBefore).toBeGreaterThan(0);

    expect(await purgeTrash()).toEqual({ note: "1 secret removed for good" });
    expect(await prisma.secret.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.secret.findUnique({ where: { id: youngId } })).not.toBeNull();

    // the journal survives the row it describes: `secretId` goes null, the label snapshot stays
    const journal = await prisma.secretAuditLog.findMany({
      where: { label: "Long gone" },
      select: { secretId: true, action: true },
    });
    expect(journal.length).toBeGreaterThan(0);
    expect(journal.every((r) => r.secretId === null)).toBe(true);

    expect((await loggedEvent("secret.purged", id)).changes).toMatchObject({
      from: "Clients › Secretful",
    });
  });
});

/**
 * **The search and a secret's History** (secrets.md §10, §11). The search reads what is OPEN about a
 * secret and the client it is filed under, never what is sealed in it, and it answers only what the
 * reader may see. Each hit carries its path, so a click can go there.
 */
describe("the search and the History panel", () => {
  const TAG = "zyxq";
  let mineId = "";
  let clientSecretId = "";
  let quietClientId = "";

  const find = (query: string, cookie = adminCookie) =>
    app.inject({
      method: "GET",
      url: `/api/secrets/search?${query}`,
      headers: { cookie },
    });
  const labels = (res: { json(): { hits: { label: string }[] } }) =>
    res
      .json()
      .hits.map((h) => h.label)
      .sort();

  beforeAll(async () => {
    const mine = await app.inject({
      method: "POST",
      url: "/api/secrets/my",
      headers: { cookie: adminCookie },
      payload: freeForm(`${TAG} personal note`, "sealed-personal-value"),
    });
    mineId = mine.json().find((s: { label: string }) => s.label === `${TAG} personal note`)!
      .id as string;

    const filed = await app.inject({
      method: "POST",
      url: `/api/secrets/clients/${clientId}`,
      headers: { cookie: adminCookie },
      payload: {
        template: "tax_account",
        label: `${TAG} state account`,
        open: { agency: "State tax department", state: "New Jersey" },
        secret: { password: `${TAG}-sealed-password`, idNumber: "NJ 123-456-789" },
      },
    });
    clientSecretId = filed
      .json()
      .find((s: { label: string }) => s.label === `${TAG} state account`)!.id as string;

    // a client with no secrets at all, which is the reason clients show in the search
    const quiet = await prisma.client.create({
      data: { firstName: `${TAG} Kovalenko` },
      select: { id: true },
    });
    quietClientId = quiet.id;
  });

  afterAll(async () => {
    await prisma.secret.deleteMany({ where: { clientId: quietClientId } });
    await prisma.client.delete({ where: { id: quietClientId } });
  });

  it("finds a secret by its own words and by its client's, in any order", async () => {
    expect(labels(await find(`q=${TAG}`))).toContain(`${TAG} state account`);
    // an open field of the template
    expect(labels(await find("q=" + encodeURIComponent("new jersey")))).toContain(
      `${TAG} state account`,
    );
    // the client it is filed under, both ways round
    expect(labels(await find("q=" + encodeURIComponent(`${TAG} Secretful`)))).toContain(
      `${TAG} state account`,
    );
  });

  it("never finds a secret by what is sealed inside it", async () => {
    expect((await find(`q=${TAG}-sealed-password`)).json().hits).toEqual([]);
    expect((await find("q=" + encodeURIComponent("NJ 123-456-789"))).json().hits).toEqual([]);
    expect((await find("q=sealed-personal-value")).json().hits).toEqual([]);
  });

  it("shows clients above the secrets, one with no secrets included, and not when narrowed", async () => {
    const found = await find("q=" + encodeURIComponent(`${TAG} Kovalenko`));
    expect(found.json().clients).toEqual([
      { id: quietClientId, label: `${TAG} Kovalenko`, code: expect.any(Number), secrets: 0 },
    ]);

    // narrowed to a template, or to a place that is not a client's, the list is secrets alone
    expect((await find(`q=${TAG}&template=tax_account`)).json().clients).toEqual([]);
    expect((await find(`q=${TAG}&place=my`)).json().clients).toEqual([]);
    expect(labels(await find(`q=${TAG}&place=my`))).toEqual([`${TAG} personal note`]);
  });

  it("gives every hit the path to where it sits", async () => {
    const hits = (await find(`q=${TAG}`)).json().hits as {
      id: string;
      path: string;
      crumbs: { label: string; to: { type: string; clientId?: string } }[];
    }[];
    const filed = hits.find((h) => h.id === clientSecretId)!;
    expect(filed.path).toBe("Clients › Secretful");
    expect(filed.crumbs).toEqual([
      { label: "Clients", to: { type: "clients" } },
      { label: "Secretful", to: { type: "client", clientId } },
    ]);
    const mine = hits.find((h) => h.id === mineId)!;
    expect(mine.crumbs).toEqual([{ label: "My secrets", to: { type: "my" } }]);
  });

  it("answers only what the reader may see", async () => {
    // a colleague's My secrets are not in anybody else's search
    expect(labels(await find(`q=${TAG}`, userCookie))).not.toContain(`${TAG} personal note`);

    // and with Clients closed, a client's secrets and the clients themselves are gone
    const userId = (
      await prisma.user.findUniqueOrThrow({
        where: { email: "sec-user@test.local" },
        select: { id: true },
      })
    ).id;
    await prisma.accessOverride.upsert({
      where: { userId_gate_action: { userId, gate: "clients", action: "*" } },
      update: { state: "closed" },
      create: { userId, gate: "clients", state: "closed" },
    });
    invalidateAccessCache();
    try {
      const closed = await find(`q=${TAG}`, userCookie);
      expect(closed.json().hits).toEqual([]);
      expect(closed.json().clients).toEqual([]);
    } finally {
      await prisma.accessOverride.update({
        where: { userId_gate_action: { userId, gate: "clients", action: "*" } },
        data: { state: "open" },
      });
      invalidateAccessCache();
    }
  });

  it("shows a secret's own journal, and nothing for one the reader cannot see", async () => {
    const mineHistory = await app.inject({
      method: "GET",
      url: `/api/secrets/history/${mineId}`,
      headers: { cookie: adminCookie },
    });
    expect(mineHistory.statusCode).toBe(200);
    expect(mineHistory.json().map((r: { action: string }) => r.action)).toContain("created");
    expect(mineHistory.json()[0].byName).toBe("Sec Admin");

    const theirs = await app.inject({
      method: "GET",
      url: `/api/secrets/history/${mineId}`,
      headers: { cookie: userCookie },
    });
    expect(theirs.statusCode).toBe(404);
  });
});

/**
 * **A leaver's My secrets** (secrets.md §8). Blocking moves them into Company in the block's own
 * transaction, the Trash's included, each one marked with whose it was; the Block dialog counts
 * them first; a save racing the block is refused; unblocking moves nothing back.
 */
describe("when somebody leaves", () => {
  const TAG = "lvq";
  let leaverId = "";
  let leaverCookie = "";

  const as = (cookie: string) => ({
    get: (url: string) => app.inject({ method: "GET", url, headers: { cookie } }),
    post: (url: string, payload: unknown) =>
      app.inject({
        method: "POST",
        url,
        headers: { cookie },
        payload: payload as Record<string, unknown>,
      }),
    patch: (url: string, payload: unknown) =>
      app.inject({
        method: "PATCH",
        url,
        headers: { cookie },
        payload: payload as Record<string, unknown>,
      }),
  });

  /** The act's row has no subject id (it moved many), so it is found by its label. */
  async function personalMoveRow(label: string) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const row = await prisma.activityEvent.findFirst({
        where: { action: "secret.personal_moved", subjectLabel: label },
        select: { changes: true, subjectId: true },
      });
      if (row) return row;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`no secret.personal_moved row for ${label} was written`);
  }

  beforeAll(async () => {
    const leaver = await prisma.user.create({
      data: {
        firstName: "Oksana",
        lastName: `Lysenko ${TAG}`,
        email: `leaver-${TAG}@test.local`,
        passwordHash: await argon2.hash(PASSWORD),
        role: "user",
        status: "active",
      },
    });
    leaverId = leaver.id;
    leaverCookie = await login(`leaver-${TAG}@test.local`);
  });

  it("moves them into Company when they are blocked, the Trash's included, marked with whose", async () => {
    const l = as(leaverCookie);
    await l.post("/api/secrets/my", freeForm(`IRS e-Services ${TAG}`, "v"));
    await l.post("/api/secrets/my", freeForm(`Old portal ${TAG}`, "v"));
    const [kept, binned] = (
      await prisma.secret.findMany({
        where: { ownerId: leaverId },
        orderBy: { label: "asc" },
        select: { id: true },
      })
    ).map((s) => s.id);
    expect((await l.post("/api/secrets/my/delete", { ids: [binned] })).json().deleted).toBe(1);

    // the Block dialog's figure: a count, the Trash's included, and never a title
    const summary = (
      await as(adminCookie).get(`/api/users/${leaverId}/personal-files-summary`)
    ).json();
    expect(summary.secrets).toBe(2);
    expect(JSON.stringify(summary)).not.toContain(TAG);

    const block = await as(adminCookie).patch(`/api/users/${leaverId}`, { status: "blocked" });
    expect(block.statusCode).toBe(200);

    const badge = `Oksana Lysenko ${TAG} (personal)`;
    const rows = await prisma.secret.findMany({
      where: { id: { in: [kept, binned] } },
      select: { id: true, space: true, ownerId: true, movedFromName: true, deletedAt: true },
    });
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (r) => r.space === "company" && r.ownerId === null && r.movedFromName === badge,
      ),
    ).toBe(true);
    // what was in the Trash stays in the Trash
    expect(rows.find((r) => r.id === binned)?.deletedAt).not.toBeNull();
    expect(await prisma.secret.count({ where: { ownerId: leaverId } })).toBe(0);

    // Company shows it to a colleague, with the badge
    const company = (await as(userCookie).get("/api/secrets/company")).json() as {
      id: string;
      movedFromName: string | null;
    }[];
    expect(company.find((s) => s.id === kept)?.movedFromName).toBe(badge);

    // one row for the act, with the figures and no title; each secret's journal says it moved
    const act = await personalMoveRow(badge);
    expect(act.subjectId).toBeNull();
    expect(act.changes).toEqual({
      secrets: 1,
      trashed: 1,
      from: `Oksana Lysenko ${TAG}'s My secrets`,
      to: "Company",
    });
    expect(
      await prisma.secretAuditLog.count({
        where: { secretId: { in: [kept, binned] }, action: "moved" },
      }),
    ).toBe(2);

    // a second Block moves nothing, and unblocking moves nothing back
    await as(adminCookie).patch(`/api/users/${leaverId}`, { status: "blocked" });
    await as(adminCookie).patch(`/api/users/${leaverId}`, { status: "active" });
    expect(await prisma.secret.count({ where: { ownerId: leaverId } })).toBe(0);
    expect(await prisma.secret.count({ where: { movedFromName: badge } })).toBe(2);

    // moving one on out of Company takes the badge off it
    const out = await as(adminCookie).post("/api/secrets/company/move", {
      ids: [kept],
      to: { space: "client", clientId },
    });
    expect(out.statusCode).toBe(200);
    expect(
      (await prisma.secret.findUniqueOrThrow({ where: { id: kept } })).movedFromName,
    ).toBeNull();
  });

  it("refuses a save into My secrets once their owner is no longer active", async () => {
    await prisma.user.update({ where: { id: leaverId }, data: { status: "blocked" } });
    // the leaver's sessions are gone, so this is the write that was already under way
    await expect(
      repo.createSecret({
        place: { space: "personal", ownerId: leaverId },
        template: "free_form",
        label: "Too late",
        description: null,
        fields: {},
        sealed: null,
        createdById: leaverId,
      }),
    ).rejects.toThrow("These personal secrets are no longer open");
    expect(await prisma.secret.count({ where: { label: "Too late" } })).toBe(0);
  });
});

/**
 * **What `--reset` does to the vault** (secrets.md §3.3), run for real: the vault's statements out
 * of `scripts/reset-data.sql`, inside a transaction that is rolled back. A text check can say the
 * lines are there; only running them says a kept secret's history survives.
 */
describe("the --reset rule", () => {
  it("a --reset keeps the history of a kept secret that once sat in a client", async () => {
    const post = (url: string, payload: unknown) =>
      app.inject({
        method: "POST",
        url,
        headers: { cookie: adminCookie },
        payload: payload as Record<string, unknown>,
      });
    const idOf = async (label: string) =>
      (await prisma.secret.findFirstOrThrow({ where: { label } })).id;

    // made in a client, then moved out into Company: kept, with its rows from the client's days
    await post(`/api/secrets/clients/${clientId}`, freeForm("Reset: moved out", "v"));
    const kept = await idOf("Reset: moved out");
    await post(`/api/secrets/clients/${clientId}/move-out`, {
      ids: [kept],
      to: { space: "company" },
    });
    // made in Company, then moved into a client: wiped, with its rows from Company's days
    await post("/api/secrets/company", freeForm("Reset: moved in", "v"));
    const movedIn = await idOf("Reset: moved in");
    await post("/api/secrets/company/move", {
      ids: [movedIn],
      to: { space: "client", clientId },
    });
    const keptRows = await prisma.secretAuditLog.count({ where: { secretId: kept } });
    expect(keptRows).toBeGreaterThanOrEqual(2);

    const sql = await readFile(
      new URL("../../../scripts/reset-data.sql", import.meta.url),
      "utf8",
    );
    const from = sql.indexOf(`UPDATE "SecretAuditLog"`);
    const to = sql.indexOf(`DELETE FROM "ClientSecret" WHERE space = 'client';`);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const statements = sql
      .slice(from, to + `DELETE FROM "ClientSecret" WHERE space = 'client';`.length)
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);

    const ROLLBACK = new Error("rolled back on purpose");
    await expect(
      prisma.$transaction(async (tx) => {
        for (const statement of statements) await tx.$executeRawUnsafe(statement);

        // the kept one: every row of its history, none of them naming the client any more
        const history = await tx.secretAuditLog.findMany({ where: { secretId: kept } });
        expect(history).toHaveLength(keptRows);
        expect(history.every((r) => r.clientId === null)).toBe(true);
        // the wiped one, and every row about it, from before its move too
        expect(await tx.secret.count({ where: { id: movedIn } })).toBe(0);
        expect(
          await tx.secretAuditLog.count({
            where: { OR: [{ secretId: movedIn }, { label: "Reset: moved in" }] },
          }),
        ).toBe(0);
        // nothing about a client is left in the journal, and Company and My secrets stay
        expect(await tx.secretAuditLog.count({ where: { clientId: { not: null } } })).toBe(0);
        expect(await tx.secret.count({ where: { space: "client" } })).toBe(0);
        expect(await tx.secret.count({ where: { id: kept, space: "company" } })).toBe(1);
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);

    expect(await prisma.secret.count({ where: { id: movedIn } })).toBe(1);
  });
});

/**
 * **What the spec audit found untested or unbuilt** (secrets.md §18, audit 2026-09-16): each rule
 * here was promised, and each one is now held by a test rather than by reading the code.
 */
describe("the audit's rules", () => {
  const TAG = "adq";
  const send = (
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: unknown,
    cookie = adminCookie,
  ) =>
    app.inject({
      method,
      url,
      headers: { cookie },
      payload: payload as Record<string, unknown>,
    });
  const idIn = (res: { json(): { id: string; label: string }[] }, label: string) =>
    res.json().find((s) => s.label === label)!.id;
  const unlock = (cookie: string) =>
    send("POST", "/api/secrets/unlock", { password: PASSWORD }, cookie);

  it("logs an edit of one of My secrets without its title or its description", async () => {
    const made = await send(
      "POST",
      "/api/secrets/my",
      freeForm(`Private ${TAG}`, "v", { description: "old words" }),
    );
    const id = idIn(made, `Private ${TAG}`);
    const edited = await send(
      "PATCH",
      `/api/secrets/my/${id}`,
      freeForm(`Renamed ${TAG}`, undefined, { description: "new words" }),
    );
    expect(edited.statusCode).toBe(200);
    const row = await loggedEvent("secret.updated", id);
    expect(row.subjectLabel).toBe("a personal secret");
    expect(row.changes).toEqual({ label: "changed", description: "changed" });
    expect(JSON.stringify(row)).not.toMatch(/Private|Renamed|old words|new words/);
  });

  it("answers for an archived client's secrets as if they were not there", async () => {
    const client = (await send("POST", "/api/clients", { firstName: `Archived ${TAG}` })).json()
      .id as string;
    const made = await send(
      "POST",
      `/api/secrets/clients/${client}`,
      freeForm(`Portal ${TAG}`, "v"),
    );
    const id = idIn(made, `Portal ${TAG}`);
    expect((await send("POST", `/api/clients/${client}/archive`)).statusCode).toBeLessThan(300);
    await unlock(adminCookie);

    const asked = [
      await send("GET", `/api/secrets/clients/${client}`),
      await send("POST", `/api/secrets/clients/${client}/${id}/reveal`),
      await send(
        "PATCH",
        `/api/secrets/clients/${client}/${id}`,
        freeForm(`Portal ${TAG}`, "w"),
      ),
      await send("POST", `/api/secrets/clients/${client}/delete`, { ids: [id] }),
      await send("POST", `/api/secrets/clients/${client}/move-out`, {
        ids: [id],
        to: { space: "company" },
      }),
      await send("GET", `/api/secrets/clients/${client}/audit`),
    ];
    expect(asked.map((r) => r.statusCode)).toEqual([404, 404, 404, 404, 404, 404]);
    const row = await prisma.secret.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ space: "client", deletedAt: null });
  });

  it("moves a secret without touching a byte of what is sealed", async () => {
    const made = await send(
      "POST",
      "/api/secrets/company",
      freeForm(`Bytes ${TAG}`, "sealed value"),
    );
    const id = idIn(made, `Bytes ${TAG}`);
    const before = await prisma.secret.findUniqueOrThrow({ where: { id } });
    await send("POST", "/api/secrets/company/move", { ids: [id], to: { space: "personal" } });
    const after = await prisma.secret.findUniqueOrThrow({ where: { id } });
    expect(after.space).toBe("personal");
    expect(Buffer.from(after.ciphertext!).equals(Buffer.from(before.ciphertext!))).toBe(true);
    expect(Buffer.from(after.iv!).equals(Buffer.from(before.iv!))).toBe(true);
    expect(Buffer.from(after.authTag!).equals(Buffer.from(before.authTag!))).toBe(true);
  });

  it("never finds a card by its CVV or its last four, and never logs either", async () => {
    const made = await send("POST", "/api/secrets/company", {
      template: "payment_card",
      label: `Card ${TAG}`,
      open: {},
      secret: { number: "5555 5555 5555 4444", expiry: "10/30", cvv: "731" },
    });
    expect(made.statusCode).toBe(201);
    const id = idIn(made, `Card ${TAG}`);
    for (const q of ["731", "4444"]) {
      const hits = (await send("GET", `/api/secrets/search?q=${q}`)).json().hits as {
        id: string;
      }[];
      expect(hits.some((h) => h.id === id)).toBe(false);
    }
    await loggedEvent("secret.created", id);
    // the WORDS of each row, not the whole row: a uuid is hex, and one holding "731" or "4444" by
    // chance failed this on a run in 2026-09-20 while proving nothing either way
    const events = await prisma.activityEvent.findMany({
      where: { subjectId: id },
      select: {
        action: true,
        subjectLabel: true,
        clientLabel: true,
        changes: true,
        route: true,
        refusalCode: true,
      },
    });
    expect(JSON.stringify(events)).not.toMatch(/731|4444|5555/);
  });

  it("finds a secret by its template's name", async () => {
    const made = await send("POST", "/api/secrets/company", {
      template: "bank",
      label: `Operating ${TAG}`,
      open: { bank: "Chase" },
      secret: null,
    });
    const id = idIn(made, `Operating ${TAG}`);
    const hits = (await send("GET", `/api/secrets/search?q=bank%20${TAG}`)).json().hits as {
      id: string;
    }[];
    expect(hits.map((h) => h.id)).toEqual([id]);
  });

  it("keeps a state only on a state tax department's account", async () => {
    const made = await send("POST", "/api/secrets/company", {
      template: "tax_account",
      label: `IRS ${TAG}`,
      open: { agency: "IRS online account", state: "New Jersey" },
      secret: null,
    });
    expect(made.statusCode).toBe(201);
    const row = made.json().find((s: { label: string }) => s.label === `IRS ${TAG}`);
    expect(row.fields).toEqual({ agency: "IRS online account" });
  });

  it("names who changed a secret last, and sorts IP PINs newest year first", async () => {
    const made = await send("POST", "/api/secrets/company", freeForm(`Shared ${TAG}`, "v"));
    const id = idIn(made, `Shared ${TAG}`);
    const edited = await send(
      "PATCH",
      `/api/secrets/company/${id}`,
      freeForm(`Shared ${TAG}`, undefined, { description: "a colleague's note" }),
      userCookie,
    );
    const row = edited.json().find((s: { id: string }) => s.id === id);
    expect(row).toMatchObject({ createdByName: "Sec Admin", updatedByName: "Sec User" });

    for (const year of ["2024", "2026", "2025"]) {
      await send("POST", "/api/secrets/company", {
        template: "ip_pin",
        label: `PIN ${year} ${TAG}`,
        open: { year, who: "taxpayer" },
        secret: null,
      });
    }
    const list = (await send("GET", "/api/secrets/company")).json() as {
      template: string;
      label: string;
    }[];
    const pins = list.filter((s) => s.template === "ip_pin" && s.label.endsWith(TAG));
    expect(pins.map((s) => s.label)).toEqual([
      `PIN 2026 ${TAG}`,
      `PIN 2025 ${TAG}`,
      `PIN 2024 ${TAG}`,
    ]);
  });

  it("keeps a second session locked while the first is open", async () => {
    await unlock(adminCookie);
    const made = await send(
      "POST",
      "/api/secrets/company",
      freeForm(`Two sessions ${TAG}`, "v"),
    );
    const id = idIn(made, `Two sessions ${TAG}`);
    expect((await send("POST", `/api/secrets/company/${id}/reveal`)).statusCode).toBe(200);
    const other = await login("sec-admin@test.local");
    expect(other).not.toBe(adminCookie);
    const locked = await send("POST", `/api/secrets/company/${id}/reveal`, undefined, other);
    expect(locked.statusCode).toBe(403);
  });
});

/**
 * **A file attached to a secret stands alone** (secrets.md §21, S18.1 stage A). The database holds
 * it: such a file is in no library place, on no task, in no client's Files and never in the Files
 * Trash, and a secret removed for good takes its rows with it.
 */
describe("a secret's files, as the database keeps them", () => {
  const row = (secretId: string, extra: Record<string, unknown> = {}) =>
    prisma.file.create({
      data: {
        name: "scan.pdf",
        size: 3,
        mime: "application/pdf",
        path: `test/${secretId}-${Math.random().toString(36).slice(2)}`,
        uploadedById: adminId,
        secretId,
        ...extra,
      },
    });
  let adminId = "";

  beforeAll(async () => {
    adminId = (await prisma.user.findFirstOrThrow({ where: { email: "sec-admin@test.local" } }))
      .id;
  });

  it("refuses a secret's file anywhere else, and lets the purge's cascade take it", async () => {
    const made = await app.inject({
      method: "POST",
      url: "/api/secrets/company",
      headers: { cookie: adminCookie },
      payload: freeForm("With a scan", "v"),
    });
    const secretId = made.json().find((s: { label: string }) => s.label === "With a scan").id;

    const ok = await row(secretId);
    await expect(row(secretId, { clientId })).rejects.toThrow(/File_secret_stands_alone/);
    await expect(row(secretId, { scope: "company" })).rejects.toThrow(
      /File_secret_stands_alone/,
    );
    await expect(
      row(secretId, {
        deletedAt: new Date(),
        deletedById: adminId,
        trashBatchId: "00000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toThrow(/File_secret_stands_alone/);

    await prisma.secret.delete({ where: { id: secretId } });
    expect(await prisma.file.findUnique({ where: { id: ok.id } })).toBeNull();
  });
});

/**
 * **A free-form secret's files** (secrets.md §21, S18.1 stage B): sealed like any file, shown as
 * open facts, opened only behind the vault's five minutes and journalled per look, taken only by
 * free form, never a program, five at most, and gone with the secret when the Trash is emptied.
 */
describe("a free-form secret's files", () => {
  const TAG = "fls";
  const PDF = "%PDF-1.4 hello";
  const upload = (
    secretId: string,
    name: string,
    body = PDF,
    cookie = adminCookie,
    type = "application/pdf",
  ) => {
    const boundary = "----buhcrmsecretfile";
    return app.inject({
      method: "POST",
      url: `/api/secrets/files?secretId=${secretId}`,
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
          `Content-Type: ${type}\r\n\r\n${body}\r\n--${boundary}--\r\n`,
      ),
    });
  };
  const send = (
    method: "GET" | "DELETE" | "POST",
    url: string,
    cookie = adminCookie,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: { cookie },
      payload: payload as Record<string, unknown>,
    });
  const make = async (payload: unknown, url = "/api/secrets/company", cookie = adminCookie) => {
    const res = await send("POST", url, cookie, payload);
    expect(res.statusCode).toBe(201);
    const label = (payload as { label: string }).label;
    return (res.json() as { id: string; label: string }[]).find((s) => s.label === label)!.id;
  };
  const unlock = (cookie = adminCookie) =>
    send("POST", "/api/secrets/unlock", cookie, { password: PASSWORD });

  it("attaches a file sealed like any other, shows it in the list, and journals it", async () => {
    const id = await make(freeForm(`Scans ${TAG}`, "v"));
    const res = await upload(id, "w9 2025.pdf");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject([{ name: "w9 2025.pdf", size: PDF.length, view: "pdf" }]);

    const row = await prisma.file.findFirstOrThrow({ where: { secretId: id } });
    expect(row.wrappedKey).not.toBeNull();
    expect(row).toMatchObject({ scope: null, taskId: null, clientId: null });

    const list = (await send("GET", "/api/secrets/company")).json() as {
      id: string;
      files: { name: string }[];
    }[];
    expect(list.find((s) => s.id === id)?.files.map((f) => f.name)).toEqual(["w9 2025.pdf"]);
    expect(
      await prisma.secretAuditLog.count({
        where: { secretId: id, action: "file_added", label: `Scans ${TAG} › w9 2025.pdf` },
      }),
    ).toBe(1);
    expect((await loggedEvent("secret.file_added", id)).changes).toEqual({
      file: "w9 2025.pdf",
      size: PDF.length,
    });
  });

  it("takes files only on a free-form secret, never a program, and five at most", async () => {
    const login = await make({
      template: "login",
      label: `Portal ${TAG}`,
      open: { site: "example.com" },
      secret: null,
    });
    const onLogin = await upload(login, "scan.pdf");
    expect(onLogin.statusCode).toBe(400);
    expect(onLogin.body).toContain("Only a free-form secret takes files");

    const id = await make(freeForm(`Five ${TAG}`, "v"));
    expect((await upload(id, "tool.exe", "MZ")).statusCode).toBe(400);
    for (let i = 1; i <= 5; i++)
      expect((await upload(id, `page ${i}.pdf`)).statusCode).toBe(201);
    const sixth = await upload(id, "page 6.pdf");
    expect(sixth.statusCode).toBe(400);
    expect(sixth.body).toContain("at most 5 files");
    expect(await prisma.file.count({ where: { secretId: id } })).toBe(5);

    // two at the same moment for the fifth place: the row lock lets one through, not both
    const race = await make(freeForm(`Race ${TAG}`, "v"));
    for (let i = 1; i <= 4; i++) await upload(race, `r${i}.pdf`);
    const both = await Promise.all([upload(race, "a.pdf"), upload(race, "b.pdf")]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([201, 400]);
    expect(await prisma.file.count({ where: { secretId: race } })).toBe(5);
  });

  it("opens a file only behind the unlock, one journal row a minute, and never a view it cannot show", async () => {
    const id = await make(freeForm(`Lease ${TAG}`, "v"));
    const [pdf] = (await upload(id, "lease.pdf")).json() as { id: string }[];
    const [doc] = (
      await upload(id, "notes.docx", "plain words", adminCookie, "application/octet-stream")
    )
      .json()
      .slice(-1) as { id: string }[];

    __clearGrants();
    expect((await send("GET", `/api/secrets/files/${pdf.id}`)).statusCode).toBe(403);
    await unlock();
    const down = await send("GET", `/api/secrets/files/${pdf.id}`);
    expect(down.statusCode).toBe(200);
    expect(down.body).toBe(PDF);
    expect(down.headers["content-disposition"]).toContain("attachment");
    const view = await send("GET", `/api/secrets/files/${pdf.id}/view`);
    expect(view.statusCode).toBe(200);
    expect(view.headers["content-type"]).toContain("application/pdf");
    expect(
      await prisma.secretAuditLog.count({
        where: { secretId: id, action: "file_opened", label: `Lease ${TAG} › lease.pdf` },
      }),
    ).toBe(1);
    expect((await loggedEvent("secret.file_opened", id)).changes).toMatchObject({
      file: "lease.pdf",
    });

    expect((await send("GET", `/api/secrets/files/${doc.id}/view`)).statusCode).toBe(400);
    expect((await send("GET", `/api/secrets/files/${doc.id}`)).statusCode).toBe(200);
  });

  it("keeps another person's My secrets' files out of reach, and logs them without a name", async () => {
    const theirs = await make(freeForm(`Mine ${TAG}`, "v"), "/api/secrets/my", userCookie);
    const [file] = (await upload(theirs, "passport.pdf", PDF, userCookie)).json() as {
      id: string;
    }[];
    expect((await loggedEvent("secret.file_added", theirs)).changes).toEqual({
      file: "a file",
      size: PDF.length,
    });

    await unlock();
    expect((await send("GET", `/api/secrets/files/${file.id}`)).statusCode).toBe(404);
    expect((await send("DELETE", `/api/secrets/files/${file.id}`)).statusCode).toBe(404);
    expect((await upload(theirs, "more.pdf")).statusCode).toBe(404);
  });

  it("finds a secret by a file's name, through an edit, and forgets it when the file goes", async () => {
    const id = await make(freeForm(`Folder ${TAG}`, "v"));
    const [file] = (await upload(id, "zqlease agreement.pdf")).json() as { id: string }[];
    const hits = async (q: string) =>
      (
        (await send("GET", `/api/secrets/search?q=${encodeURIComponent(q)}`)).json().hits as {
          id: string;
        }[]
      ).map((h) => h.id);
    expect(await hits("zqlease")).toContain(id);

    // an edit writes the search words again, and must keep the file's name in them
    await app.inject({
      method: "PATCH",
      url: `/api/secrets/company/${id}`,
      headers: { cookie: adminCookie },
      payload: freeForm(`Folder renamed ${TAG}`),
    });
    expect(await hits("zqlease")).toContain(id);

    const removed = await send("DELETE", `/api/secrets/files/${file.id}`);
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual([]);
    expect(await hits("zqlease")).not.toContain(id);
    expect(await prisma.file.findUnique({ where: { id: file.id } })).toBeNull();
    expect((await loggedEvent("secret.file_removed", id)).changes).toEqual({
      file: "zqlease agreement.pdf",
    });
  });

  it("removes a secret's files with it when the Trash is emptied, the bytes first", async () => {
    const id = await make(freeForm(`Old scans ${TAG}`, "v"));
    await upload(id, "old.pdf");
    const row = await prisma.file.findFirstOrThrow({ where: { secretId: id } });
    expect(existsSync(join(TEST_UPLOADS_DIR, row.path))).toBe(true);

    expect(
      (await send("POST", "/api/secrets/company/delete", adminCookie, { ids: [id] }))
        .statusCode,
    ).toBe(200);
    // in the Trash the file waits with its secret
    expect(await prisma.file.findUnique({ where: { id: row.id } })).not.toBeNull();
    await prisma.secret.update({
      where: { id },
      data: { deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
    });
    await purgeTrash();
    expect(await prisma.secret.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.file.findUnique({ where: { id: row.id } })).toBeNull();
    expect(existsSync(join(TEST_UPLOADS_DIR, row.path))).toBe(false);
  });
});

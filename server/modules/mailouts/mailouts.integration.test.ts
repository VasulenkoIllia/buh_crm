import argon2 from "argon2";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { prisma } from "../../core/db.js";
import { testOutbox } from "../../core/email.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;
let clientA: string; // complete card — everything a letter could ask for
let clientB: string; // no companyName — blocked by a letter that uses {{company}}
let clientC: string; // no email at all
let kvitka: string; // clientA's company, with an inbox of its own
let sonyachny: string; // clientA's company with NO inbox — must be skipped, never redirected
let petrosCompany: string; // clientB's — proves one client cannot address another's

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

/** Delivery runs after the response, so the log settles a tick later. */
async function settled(mailoutId: string) {
  for (let i = 0; i < 60; i++) {
    const rows = await prisma.mailoutRecipient.findMany({ where: { mailoutId } });
    if (!rows.some((r) => r.status === "queued")) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("delivery did not settle");
}

beforeAll(async () => {
  app = await buildApp();
  // The same order `api-contract.test.ts` proves out. This suite used to start at the mail tables,
  // so anything that had left an Invoice or a Task behind made `client.deleteMany()` fail on a
  // RESTRICT key — and vitest reports a throwing `beforeAll` as 68 SKIPPED, not as a failure. A
  // suite that silently declines to run is worse than one that breaks loudly.
  await prisma.invoiceLine.deleteMany();
  await prisma.paymentAuditLog.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.mailoutRecipient.deleteMany();
  await prisma.mailout.deleteMany();
  await prisma.campaignRecipient.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.clientMailPreference.deleteMany();
  await prisma.emailTemplate.deleteMany();
  await prisma.mailSenderAccount.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.task.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.company.deleteMany();
  await prisma.client.deleteMany();
  await prisma.session.deleteMany();
  await prisma.firmProfile.deleteMany();
  // before users: File.uploadedById points at one, and a letterhead left behind by a failed run
  // would otherwise break this teardown for every future run
  await prisma.file.deleteMany();
  await prisma.user.deleteMany();

  await prisma.firmProfile.create({
    data: {
      id: 1,
      name: "ILLION Tax & Accounting",
      postalAddress: "1200 Main St, Suite 4, Charlotte, NC 28202",
    },
  });
  await prisma.mailSenderAccount.create({
    data: {
      name: "Main",
      fromName: "ILLION Tax & Accounting",
      fromEmail: "info@illion.tax",
      signature: "Maryna Onyshchenko, EA, MBA\nILLION — tax & accounting",
      isDefault: true,
    },
  });

  const hash = await argon2.hash("password-123");
  await prisma.user.create({
    data: {
      email: "admin@example.com",
      passwordHash: hash,
      firstName: "Ada",
      lastName: "Admin",
      role: "admin",
      status: "active",
    },
  });

  const a = await prisma.client.create({
    data: {
      firstName: "Olena",
      lastName: "Kovalenko",
      companyName: "Kvitka Trade LLC",
      email: "olena@example.com",
      companies: {
        create: [
          {
            // deliberately NOT the client's `companyName` above: with the two spelled alike, a
            // letter that wrongly used the card's label would render identically and every
            // assertion here would pass against a broken renderer
            name: "Kvitka Payroll LLC",
            email: "office@kvitka.example",
            phone: "+1 704 555 0100",
            order: 0,
          },
          { name: "Sonyachny FOP", order: 1 },
        ],
      },
    },
    include: { companies: true },
  });
  const b = await prisma.client.create({
    data: {
      firstName: "Petro",
      lastName: "Bond",
      email: "petro@example.com",
      companies: { create: [{ name: "Bond Logistics", email: "ops@bond.example" }] },
    },
    include: { companies: true },
  });
  const c = await prisma.client.create({ data: { firstName: "Nadia", lastName: "NoMail" } });
  clientA = a.id;
  clientB = b.id;
  clientC = c.id;
  kvitka = a.companies.find((co) => co.name === "Kvitka Payroll LLC")!.id;
  sonyachny = a.companies.find((co) => co.name === "Sonyachny FOP")!.id;
  petrosCompany = b.companies[0]!.id;

  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "admin@example.com", password: "password-123" },
  });
  cookie = cookieOf(res);
});

afterAll(async () => {
  // Clear this suite's rows, not just claim the database at the start.
  //
  // `MailoutRecipient.companyId` is ON DELETE RESTRICT — the point being that a sent letter keeps
  // its company alive. Left behind, those rows make `company.deleteMany()` fail in EVERY suite
  // that runs after this one (the files share one database and run in order), which reads as a
  // failure in whichever test happens to be next rather than as leftovers from here.
  await prisma.mailoutRecipient.deleteMany();
  await prisma.mailout.deleteMany();
  await app.close();
});

beforeEach(() => {
  testOutbox.length = 0;
});

const letter = (over: Record<string, unknown> = {}) => ({
  subject: "Your {{company}} filing",
  heading: "Hello {{first_name}}",
  body: "Dear {{first_name}},\n\nYour {{company}} return is ready.",
  kind: "commercial",
  ...over,
});

/**
 * Clients as plain addressees — "send to these people at their own addresses".
 *
 * The wire shape is `{clientId, companyId?}` because a send may be addressed to one of a client's
 * companies instead. Most tests are not about that, and spelling out the object every time would
 * bury the thing each one is actually checking.
 */
const to = (...clientIds: string[]) => clientIds.map((clientId) => ({ clientId }));

/** One of a client's companies as the addressee. */
const toCompany = (clientId: string, companyId: string) => [{ clientId, companyId }];

async function send(payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/mailouts/send",
    headers: { cookie },
    payload,
  });
}

describe("sending", () => {
  it("personalises each letter from the client card", async () => {
    const res = await send({ letter: letter(), recipients: to(clientA) });
    expect(res.statusCode).toBe(201);
    await settled(res.json().id);

    expect(testOutbox).toHaveLength(1);
    const mail = testOutbox[0];
    expect(mail.to).toBe("olena@example.com");
    expect(mail.subject).toBe("Your Kvitka Trade LLC filing");
    expect(mail.html).toContain("Hello Olena");
    expect(mail.html).toContain("Your Kvitka Trade LLC return is ready.");
    expect(mail.from).toBe('"ILLION Tax & Accounting" <info@illion.tax>');
  });

  /**
   * The rule the module exists to keep. A client the letter cannot be personalised for is written
   * into the log with the reason — not quietly dropped, and not sent a letter with a hole in it.
   */
  it("skips a client whose card lacks a variable the letter uses, and records why", async () => {
    const res = await send({ letter: letter(), recipients: to(clientA, clientB) });
    const rows = await settled(res.json().id);

    const b = rows.find((r) => r.clientId === clientB)!;
    expect(b.status).toBe("skipped");
    expect(b.reason).toContain("{{company}}");
    expect(rows.find((r) => r.clientId === clientA)!.status).toBe("sent");
    expect(testOutbox.map((m) => m.to)).toEqual(["olena@example.com"]);
  });

  it("skips a client with no email address", async () => {
    const res = await send({
      letter: letter({ subject: "News", heading: null, body: "Hello {{first_name}}." }),
      recipients: to(clientA, clientC),
    });
    const rows = await settled(res.json().id);
    const c = rows.find((r) => r.clientId === clientC)!;
    expect(c.status).toBe("skipped");
    expect(c.reason).toMatch(/no email/i);
  });

  it("refuses a send where nobody is reachable, rather than logging an empty success", async () => {
    const res = await send({
      letter: letter({ subject: "News", heading: null, body: "Hi." }),
      recipients: to(clientC),
    });
    expect(res.statusCode).toBe(400);
  });

  it("keeps a snapshot of the letter, so editing a template cannot rewrite history", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/mailouts/templates",
      headers: { cookie },
      payload: { name: "Season greetings", subject: "Original subject", body: "Original body" },
    });
    const templateId = created.json().id;

    const res = await send({ templateId, recipients: to(clientA) });
    await settled(res.json().id);

    await app.inject({
      method: "PATCH",
      url: `/api/mailouts/templates/${templateId}`,
      headers: { cookie },
      payload: { subject: "Rewritten subject", body: "Rewritten body" },
    });

    const log = await app.inject({
      method: "GET",
      url: `/api/mailouts/${res.json().id}`,
      headers: { cookie },
    });
    expect(log.json().subject).toBe("Original subject");
    expect(log.json().body).toBe("Original body");
  });
});

describe("CAN-SPAM", () => {
  it("refuses commercial mail when the firm has no postal address", async () => {
    await prisma.firmProfile.update({ where: { id: 1 }, data: { postalAddress: null } });
    const res = await send({ letter: letter(), recipients: to(clientA) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/postal address/i);

    await prisma.firmProfile.update({
      where: { id: 1 },
      data: { postalAddress: "1200 Main St, Suite 4, Charlotte, NC 28202" },
    });
  });

  it("lets transactional mail through without one — an invoice is exempt", async () => {
    await prisma.firmProfile.update({ where: { id: 1 }, data: { postalAddress: null } });
    const res = await send({
      letter: letter({
        kind: "transactional",
        subject: "Invoice",
        heading: null,
        body: "Attached.",
      }),
      recipients: to(clientA),
    });
    expect(res.statusCode).toBe(201);
    await settled(res.json().id);

    await prisma.firmProfile.update({
      where: { id: 1 },
      data: { postalAddress: "1200 Main St, Suite 4, Charlotte, NC 28202" },
    });
  });

  it("puts the postal address and an unsubscribe link in commercial mail only", async () => {
    const commercial = await send({
      letter: letter({ subject: "News", heading: null, body: "Hi {{first_name}}." }),
      recipients: to(clientA),
    });
    await settled(commercial.json().id);
    expect(testOutbox[0].html).toContain("Charlotte, NC 28202");
    expect(testOutbox[0].html).toContain("/api/mailouts/unsubscribe/");

    testOutbox.length = 0;
    const transactional = await send({
      letter: letter({
        kind: "transactional",
        subject: "Invoice",
        heading: null,
        body: "Attached.",
      }),
      recipients: to(clientA),
    });
    await settled(transactional.json().id);
    expect(testOutbox[0].html).not.toContain("Charlotte, NC 28202");
    expect(testOutbox[0].html).not.toContain("/unsubscribe/");
  });
});

describe("unsubscribe", () => {
  async function tokenFor(clientId: string) {
    const pref = await prisma.clientMailPreference.findUnique({ where: { clientId } });
    return pref!.token;
  }

  beforeEach(async () => {
    await prisma.clientMailPreference.updateMany({ data: { unsubscribedAt: null } });
  });

  it("does not unsubscribe on GET — a mail scanner following the link must change nothing", async () => {
    await send({
      letter: letter({ subject: "N", heading: null, body: "Hi." }),
      recipients: to(clientA),
    });
    const token = await tokenFor(clientA);

    const res = await app.inject({ method: "GET", url: `/api/mailouts/unsubscribe/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<form");
    const pref = await prisma.clientMailPreference.findUnique({ where: { clientId: clientA } });
    expect(pref!.unsubscribedAt).toBeNull();
  });

  it("unsubscribes on POST, with no login", async () => {
    const token = await tokenFor(clientA);
    const res = await app.inject({ method: "POST", url: `/api/mailouts/unsubscribe/${token}` });
    expect(res.statusCode).toBe(200);
    const pref = await prisma.clientMailPreference.findUnique({ where: { clientId: clientA } });
    expect(pref!.unsubscribedAt).not.toBeNull();
  });

  /**
   * The two tests below exist because the one above passed while the feature was broken.
   *
   * `inject` with no payload sends no `Content-Type`, and the app is otherwise JSON-only — so a
   * real HTML form post and a real RFC 8058 one-click, both `application/x-www-form-urlencoded`,
   * were answered 415 by Fastify. Every actual mail client would have hit that; the harness never
   * did. Assert the encoding the callers really use.
   */
  it("accepts the form encoding a real browser sends (not just a bare inject)", async () => {
    const token = await tokenFor(clientA);
    const res = await app.inject({
      method: "POST",
      url: `/api/mailouts/unsubscribe/${token}`,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost:3000",
      },
      payload: "",
    });
    expect(res.statusCode).toBe(200);
    const pref = await prisma.clientMailPreference.findUnique({ where: { clientId: clientA } });
    expect(pref!.unsubscribedAt).not.toBeNull();
  });

  it("accepts RFC 8058 one-click, and is not blocked by the Origin check", async () => {
    const token = await tokenFor(clientA);
    const res = await app.inject({
      method: "POST",
      url: `/api/mailouts/unsubscribe/${token}`,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // a webmail posting from its own page — the app-wide CSRF check would 403 this, and must
        // not, because there is no session here for a forged request to ride
        origin: "https://mail.google.com",
      },
      payload: "List-Unsubscribe=One-Click",
    });
    expect(res.statusCode).toBe(200);
    const pref = await prisma.clientMailPreference.findUnique({ where: { clientId: clientA } });
    expect(pref!.unsubscribedAt).not.toBeNull();
  });

  /** The opt-out is one route wide. Everything else must still refuse a cross-origin post. */
  it("does not weaken the Origin check anywhere else", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mailouts/send",
      headers: { cookie, origin: "https://evil.example.com" },
      payload: { letter: letter(), recipients: to(clientA) },
    });
    expect(res.statusCode).toBe(403);
  });

  /** The whole reason `kind` is stored: unsubscribing from news must not stop the bills. */
  it("blocks later commercial mail but never transactional mail", async () => {
    const token = await tokenFor(clientA);
    await app.inject({ method: "POST", url: `/api/mailouts/unsubscribe/${token}` });

    testOutbox.length = 0;
    const commercial = await send({
      letter: letter({ subject: "News", heading: null, body: "Hi." }),
      recipients: to(clientA),
    });
    expect(commercial.statusCode).toBe(400); // A is the only recipient, and A unsubscribed
    testOutbox.length = 0;

    const transactional = await send({
      letter: letter({
        kind: "transactional",
        subject: "Invoice 42",
        heading: null,
        body: "Due.",
      }),
      recipients: to(clientA),
    });
    expect(transactional.statusCode).toBe(201);
    const rows = await settled(transactional.json().id);
    expect(rows[0].status).toBe("sent");
    expect(testOutbox).toHaveLength(1);
  });

  it("records an unsubscribed client as skipped, with the reason", async () => {
    const token = await tokenFor(clientA);
    await app.inject({ method: "POST", url: `/api/mailouts/unsubscribe/${token}` });

    const res = await send({
      letter: letter({ subject: "News", heading: null, body: "Hi {{first_name}}." }),
      recipients: to(clientA, clientC),
    });
    expect(res.statusCode).toBe(400);

    const state = await app.inject({
      method: "GET",
      url: `/api/mailouts/clients/${clientA}`,
      headers: { cookie },
    });
    expect(state.json().subscribed).toBe(false);
  });

  it("answers an unknown token with a page, not a stack trace", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/mailouts/unsubscribe/nope-nope-nope",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("no longer valid");
    expect(res.body).not.toContain("<form");
  });

  it("re-subscribes from the client card", async () => {
    const token = await tokenFor(clientA);
    await app.inject({ method: "POST", url: `/api/mailouts/unsubscribe/${token}` });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/mailouts/clients/${clientA}/subscription`,
      headers: { cookie },
      payload: { subscribed: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().subscribed).toBe(true);
  });
});

describe("sender mailboxes", () => {
  const state = async () =>
    (
      await app.inject({
        method: "GET",
        url: "/api/mailouts/settings/senders",
        headers: { cookie },
      })
    ).json();

  const main = async () =>
    (await state()).accounts.find((a: { name: string }) => a.name === "Main");

  const messages = (checks: { level: string; message: string }[], level?: string) =>
    checks
      .filter((c) => !level || c.level === level)
      .map((c) => c.message)
      .join(" | ");

  const patchMain = async (data: Record<string, unknown>) => {
    const account = await main();
    await prisma.mailSenderAccount.update({ where: { id: account.id }, data });
  };

  afterAll(async () => {
    await prisma.mailSenderAccount.deleteMany({ where: { isDefault: false } });
    await patchMain({
      fromEmail: "info@illion.tax",
      smtpHost: null,
      smtpPort: null,
      smtpUser: null,
      active: true,
    });
    await prisma.firmProfile.update({
      where: { id: 1 },
      data: { postalAddress: "1200 Main St, Suite 4, Charlotte, NC 28202" },
    });
  });

  it("adds a second mailbox, and the first stays the default", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mailouts/settings/senders",
      headers: { cookie },
      payload: {
        name: "Invoices",
        fromName: "ILLION Billing",
        fromEmail: "billing@illion.tax",
      },
    });
    expect(res.statusCode).toBe(201);

    const accounts = res.json().accounts;
    expect(accounts).toHaveLength(2);
    expect(accounts.filter((a: { isDefault: boolean }) => a.isDefault)).toHaveLength(1);
    expect(accounts.find((a: { isDefault: boolean }) => a.isDefault).name).toBe("Main");
  });

  /**
   * A mailbox that only sends is half a mailbox: bounces come back as ordinary mail, and reading
   * them needs its own host, port and — usually not — its own credentials.
   */
  it("stores an IMAP block, seals its password, and never returns it", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/mailouts/settings/senders",
      headers: { cookie },
      payload: {
        name: "Reminders",
        fromEmail: "reminder@illion.tax",
        imapHost: "mail.illion.tax",
        imapPort: 993,
        imapSecure: true,
        imapUser: "reminder@illion.tax",
        imapPass: "not-a-real-password",
      },
    });
    expect(created.statusCode).toBe(201);

    const account = created
      .json()
      .accounts.find((a: { name: string }) => a.name === "Reminders");
    expect(account.imapHost).toBe("mail.illion.tax");
    expect(account.imapPort).toBe(993);
    expect(account.readsBounces).toBe(true);
    expect(account.imapPassSet).toBe(true);
    // The password itself must never cross the wire, exactly like the SMTP one.
    expect(JSON.stringify(account)).not.toContain("not-a-real-password");

    // Prisma 7 hands `Bytes` back as a Uint8Array, so decode rather than assume a Buffer.
    const row = await prisma.mailSenderAccount.findUnique({ where: { id: account.id } });
    expect(row?.imapPass?.byteLength).toBeGreaterThan(0);
    expect(row?.imapPassIv?.byteLength).toBeGreaterThan(0);
    expect(row?.imapPassTag?.byteLength).toBeGreaterThan(0);
    expect(Buffer.from(row!.imapPass!).toString("utf8")).not.toContain("not-a-real-password");
  });

  /**
   * The failure worth naming: a half-filled block reads as configured on the screen and is skipped
   * by the reader, so a firm believes bounces are watched while nothing is watching them.
   */
  it("calls a half-filled IMAP block an error, and a missing one a warning", async () => {
    const half = await app.inject({
      method: "POST",
      url: "/api/mailouts/settings/senders",
      headers: { cookie },
      payload: { name: "Half", fromEmail: "half@illion.tax", imapHost: "mail.illion.tax" },
    });
    const account = half.json().accounts.find((a: { name: string }) => a.name === "Half");
    expect(account.readsBounces).toBe(false);
    const port = account.checks.find((c: { field: string }) => c.field === "imapPort");
    expect(port.level).toBe("error");

    // A mailbox with no IMAP at all is not broken — it is unwatched, and the screen says so.
    const main = half.json().accounts.find((a: { name: string }) => a.name === "Main");
    const unread = main.checks.find((c: { field: string }) => c.field === "imapHost");
    expect(unread.level).toBe("warning");
    expect(unread.message).toContain("still read as sent");
  });

  it("refuses a duplicate name, case-insensitively", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mailouts/settings/senders",
      headers: { cookie },
      payload: { name: "INVOICES", fromEmail: "x@illion.tax" },
    });
    expect(res.statusCode).toBe(409);
  });

  /**
   * A partial unique index enforces "at most one default" in the database, so moving it has to
   * clear and set in one transaction. Two defaults would make "which mailbox does this go from"
   * depend on row order.
   */
  it("moves the default without ever leaving two", async () => {
    const before = await state();
    const invoices = before.accounts.find((a: { name: string }) => a.name === "Invoices");

    const res = await app.inject({
      method: "POST",
      url: `/api/mailouts/settings/senders/${invoices.id}/default`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const after = res.json().accounts;
    expect(after.filter((a: { isDefault: boolean }) => a.isDefault)).toHaveLength(1);
    expect(after.find((a: { isDefault: boolean }) => a.isDefault).name).toBe("Invoices");

    // put it back
    const mainAccount = after.find((a: { name: string }) => a.name === "Main");
    await app.inject({
      method: "POST",
      url: `/api/mailouts/settings/senders/${mainAccount.id}/default`,
      headers: { cookie },
    });
  });

  it("will not delete or deactivate the default — every send needs a fallback", async () => {
    const account = await main();
    const del = await app.inject({
      method: "DELETE",
      url: `/api/mailouts/settings/senders/${account.id}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(409);

    const off = await app.inject({
      method: "PATCH",
      url: `/api/mailouts/settings/senders/${account.id}`,
      headers: { cookie },
      payload: { active: false },
    });
    expect(off.statusCode).toBe(409);
  });

  it("a send goes from the mailbox it names, and the log records which", async () => {
    const accounts = (await state()).accounts;
    const invoices = accounts.find((a: { name: string }) => a.name === "Invoices");

    const res = await send({
      letter: letter({
        kind: "transactional",
        subject: "Invoice",
        heading: null,
        body: "Due.",
      }),
      recipients: to(clientA),
      senderAccountId: invoices.id,
    });
    expect(res.statusCode).toBe(201);
    await settled(res.json().id);

    expect(testOutbox[0].from).toBe('"ILLION Billing" <billing@illion.tax>');
    const row = await prisma.mailout.findUnique({ where: { id: res.json().id } });
    expect(row!.senderAccountId).toBe(invoices.id);
  });

  it("falls back to the template's mailbox, then to the default", async () => {
    const invoices = (await state()).accounts.find(
      (a: { name: string }) => a.name === "Invoices",
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/mailouts/templates",
      headers: { cookie },
      payload: {
        name: "Billing note",
        subject: "Invoice",
        body: "Due.",
        kind: "transactional",
        senderAccountId: invoices.id,
      },
    });
    expect(created.statusCode).toBe(201);

    // no senderAccountId on the send — the template's wins
    const res = await send({ templateId: created.json().id, recipients: to(clientA) });
    await settled(res.json().id);
    expect(testOutbox[0].from).toBe('"ILLION Billing" <billing@illion.tax>');
  });

  it("will not delete a mailbox that history points at", async () => {
    const invoices = (await state()).accounts.find(
      (a: { name: string }) => a.name === "Invoices",
    );
    const res = await app.inject({
      method: "DELETE",
      url: `/api/mailouts/settings/senders/${invoices.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/deactivate/i);
  });

  // ── the checks ────────────────────────────────────────────────────────────

  /**
   * The failure this exists to prevent: almost every SMTP server refuses to send as an address it
   * did not authenticate, and the ones that allow it produce mail that fails SPF/DKIM alignment.
   * Neither is visible in development — Mailpit accepts anything — so without this check the firm
   * finds out on the server, on the first real mailout.
   */
  it("calls a From on a different domain from the authenticated account an error", async () => {
    await patchMain({
      smtpHost: "mail.example.com",
      smtpPort: 587,
      smtpUser: "reminder@example.com",
      fromEmail: "info@illion.tax",
    });
    expect(messages((await main()).checks, "error")).toMatch(/different domain/i);
  });

  it("softens to a warning when the domain matches — it usually works, but must be tested", async () => {
    await patchMain({ smtpUser: "reminder@illion.tax", fromEmail: "info@illion.tax" });
    const mismatch = (await main()).checks.find((c: { message: string }) =>
      /did not authenticate/i.test(c.message),
    );
    expect(mismatch?.level).toBe("warning");
  });

  it("says nothing about the From when it matches the account", async () => {
    await patchMain({ smtpUser: "info@illion.tax", fromEmail: "info@illion.tax" });
    expect(messages((await main()).checks)).not.toMatch(/authenticate|different domain/i);
  });

  /**
   * Where does a reply go? To the From address, unless a Reply-to says otherwise — so a `noreply@`
   * From with no Reply-to means a client who answers reaches nobody, and believes they answered.
   * Silent, and only discovered when somebody asks why a client never got back to them.
   */
  it("warns when a noreply From has nowhere for replies to land", async () => {
    await patchMain({ fromEmail: "noreply@illion.tax", replyTo: "" });
    expect(messages((await main()).checks, "warning")).toMatch(/reaches nobody/i);

    await patchMain({ replyTo: "info@illion.tax" });
    expect(messages((await main()).checks)).not.toMatch(/reaches nobody/i);

    // …and an ordinary From is not nagged about it: replies land in that inbox already
    await patchMain({ fromEmail: "info@illion.tax", replyTo: "" });
    expect(messages((await main()).checks)).not.toMatch(/reaches nobody/i);
  });

  it("flags a half-built mailbox: a host with no port, a user with no password", async () => {
    await patchMain({ smtpHost: "mail.illion.tax", smtpPort: null });
    expect(messages((await main()).checks, "error")).toMatch(/no port/i);

    await patchMain({ smtpPort: 587 });
    expect(messages((await main()).checks, "error")).toMatch(/no password/i);
  });

  it("flags the missing postal address on every mailbox — it blocks them all", async () => {
    await prisma.firmProfile.update({ where: { id: 1 }, data: { postalAddress: null } });
    const body = await state();
    expect(body.postalAddress).toBeNull();
    for (const account of body.accounts) {
      expect(messages(account.checks, "error")).toMatch(/postal address/i);
    }
    await prisma.firmProfile.update({
      where: { id: 1 },
      data: { postalAddress: "1200 Main St, Suite 4, Charlotte, NC 28202" },
    });
  });

  /**
   * The buttons used to be parsed out of the signature, which meant guessing. These pin that the
   * letter now shows exactly the channels the firm filled in — no more, no fewer.
   */
  it("puts one contact button in the letter per filled field", async () => {
    await patchMain({
      contactEmail: "info@illion.tax",
      contactPhone: "+1 (704) 726-6994",
      contactTelegram: "@illion_tax",
      contactWhatsapp: "+1 (704) 726-6994",
      contactViber: null,
      contactWebsite: "illion.tax",
    });

    const res = await send({
      letter: letter({ subject: "News", heading: null, body: "Hi {{first_name}}." }),
      recipients: to(clientA),
    });
    await settled(res.json().id);
    const html = testOutbox[0].html;

    expect(html).toContain("mailto:info@illion.tax");
    expect(html).toContain("tel:+17047266994");
    expect(html).toContain("https://t.me/illion_tax");
    expect(html).toContain("https://wa.me/17047266994");
    // four fit; the website is the one dropped, and Viber was never filled in
    expect(html).not.toContain("viber://");
    expect(html).not.toContain(">illion.tax<");
  });

  it("shows no buttons at all when no channel is filled in", async () => {
    await patchMain({
      contactEmail: null,
      contactPhone: null,
      contactTelegram: null,
      contactWhatsapp: null,
      contactViber: null,
      contactWebsite: null,
    });

    const res = await send({
      letter: letter({ subject: "News", heading: null, body: "Hi {{first_name}}." }),
      recipients: to(clientA),
    });
    await settled(res.json().id);
    for (const scheme of ["mailto:", "tel:", "t.me", "wa.me", "viber://"]) {
      expect(testOutbox[0].html, scheme).not.toContain(scheme);
    }
  });

  /**
   * Stored now so Payments has somewhere to read from when invoice-by-email lands.
   *
   * MOVED, not merely set: the flag has a partial unique index, so naming a second mailbox has to
   * clear the first in the same transaction. Setting it once on an empty field would pass even
   * with that step deleted — which is exactly what the first version of this test did.
   */
  it("moves the invoice sender rather than ending up with two", async () => {
    const accounts = (await state()).accounts;
    const invoices = accounts.find((a: { name: string }) => a.name === "Invoices");
    const mainAccount = accounts.find((a: { name: string }) => a.name === "Main");

    const flag = (id: string) =>
      app.inject({
        method: "POST",
        url: `/api/mailouts/settings/senders/${id}/invoice-sender`,
        headers: { cookie },
      });

    expect((await flag(mainAccount.id)).statusCode).toBe(200);

    const res = await flag(invoices.id); // the move — this is the part that needs the clear
    expect(res.statusCode).toBe(200);

    const after = res.json().accounts;
    const flagged = after.filter((a: { isInvoiceSender: boolean }) => a.isInvoiceSender);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].name).toBe("Invoices");
  });

  /**
   * Switching a mailbox back to the server account has to CLEAR the old SMTP fields. Leaving a
   * host behind with the port nulled would read as configured while behaving as unconfigured —
   * and `hasOwnSmtp` would disagree with the editor about which one this mailbox is.
   */
  it("clears the SMTP fields when a mailbox goes back to the server mailbox", async () => {
    const account = await main();
    await app.inject({
      method: "PATCH",
      url: `/api/mailouts/settings/senders/${account.id}`,
      headers: { cookie },
      payload: {
        smtpHost: "mail.illion.tax",
        smtpPort: 587,
        smtpUser: "info@illion.tax",
      },
    });
    expect((await main()).ownSmtp).toBe(true);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/mailouts/settings/senders/${account.id}`,
      headers: { cookie },
      payload: { smtpHost: "", smtpPort: null, smtpSecure: null, smtpUser: "", smtpPass: "" },
    });
    expect(res.statusCode).toBe(200);

    const after = await main();
    expect(after.ownSmtp).toBe(false);
    expect(after.smtpHost).toBeNull();
    expect(after.smtpPort).toBeNull();
    expect(after.smtpPassSet).toBe(false);
    expect(after.effectiveAccount).toMatch(/server's own mailbox/i);
  });

  it("names the .env account once, at the top, so the editor can show it with no mailboxes", async () => {
    const body = await state();
    expect(body.server.label).toContain(":");
    expect(body.server.fromEmail).toBeTruthy();
  });

  it("shows the account letters really go over, .env fallback included", async () => {
    await patchMain({ smtpHost: null, smtpPort: null });
    const account = await main();
    expect(account.ownSmtp).toBe(false);
    expect(account.effectiveAccount).toMatch(/server's own mailbox/i);
    expect(messages(account.checks, "warning")).toMatch(/password resets/i);
  });
});

describe("when the sending account is unusable", () => {
  afterAll(async () => {
    await prisma.mailSenderAccount.updateMany({
      data: {
        smtpHost: null,
        smtpPort: null,
        smtpPass: null,
        smtpPassIv: null,
        smtpPassTag: null,
      },
    });
  });

  /**
   * The failure this guards against is silence. Resolving the account happens BEFORE the first
   * letter — `open()` rejects a sealed password once `SECRETS_KEY` is absent or rotated — and an
   * escaping error would leave every row `queued` forever behind a screen reading "sending".
   * A stuck row that never resolves is a worse lie than a failure.
   */
  it("fails every recipient with a reason instead of leaving them queued forever", async () => {
    await prisma.mailSenderAccount.updateMany({
      where: { isDefault: true },
      data: {
        smtpHost: "mail.example.com",
        smtpPort: 587,
        // ciphertext that no key can open — the shape a rotated SECRETS_KEY leaves behind
        smtpPass: Buffer.from("not really encrypted"),
        smtpPassIv: Buffer.from("0123456789ab"),
        smtpPassTag: Buffer.from("0123456789abcdef"),
        smtpKeyVersion: 1,
      },
    });

    const res = await send({
      letter: letter({ subject: "News", heading: null, body: "Hi {{first_name}}." }),
      recipients: to(clientA),
    });
    expect(res.statusCode).toBe(201);

    const rows = await settled(res.json().id); // would time out if they stayed queued
    expect(rows[0].status).toBe("failed");
    expect(rows[0].reason).toMatch(/sender account unusable/i);
  });
});

describe("preview", () => {
  it("names who will be skipped before anything is sent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mailouts/preview",
      headers: { cookie },
      payload: { letter: letter(), recipients: to(clientA, clientB, clientC) },
    });
    const body = res.json();
    expect(body.sendable).toBe(1);
    expect(body.blocked).toBe(2);
    expect(
      body.rows.find((r: { clientId: string }) => r.clientId === clientB).blockedReason,
    ).toContain("{{company}}");
    expect(testOutbox).toHaveLength(0);
  });

  /**
   * The composer's preview had the same dead `cid:` the template preview did — fixed in one place
   * and missed in the other, because `buildEmail` decided the source itself and is called by both
   * a real send and a preview. This asserts BOTH previews at once so the next miss cannot be
   * half-caught.
   *
   * The letterhead is uploaded through the real endpoint rather than faked as a File row: a row
   * pointing at a file that is not on disk makes `loadLogo` return null, and then `cid:` and
   * `data:` both render as "no logo" — a test that passes whichever way the bug goes.
   */
  it("inlines the letterhead in every preview, and points at the attachment only when sending", async () => {
    // the smallest valid PNG — 1×1, transparent
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const boundary = "----test";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="mark.png"\r\n` +
          `Content-Type: image/png\r\n\r\n`,
      ),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const upload = await app.inject({
      method: "PUT",
      url: "/api/mailouts/settings/mail-logo",
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(upload.statusCode).toBe(200);
    expect(upload.json().logo).toBeTruthy();

    try {
      // The composer's check step no longer renders a letter at all — the two wirings that remain
      // are the editor's preview (inline bytes) and the real send (its own attachment), which is
      // exactly the split that produced the broken-image bug.
      const editor = await app.inject({
        method: "POST",
        url: "/api/mailouts/preview/letter",
        headers: { cookie },
        payload: letter(),
      });
      expect(editor.json().html).toContain("data:image/png;base64,");
      expect(editor.json().html).not.toContain("cid:");

      // …while a real send still points at the attachment it carries
      const sent = await send({ letter: letter(), recipients: to(clientA) });
      await settled(sent.json().id);
      expect(testOutbox[0].html).toContain("cid:firm-logo");
    } finally {
      await app.inject({
        method: "DELETE",
        url: "/api/mailouts/settings/mail-logo",
        headers: { cookie },
      });
    }
  });

  it("previews against a client who will actually receive it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mailouts/preview",
      headers: { cookie },
      payload: { letter: letter(), recipients: to(clientB, clientA) },
    });
    // B is first in the list but blocked — the preview must not show B's broken letter
    expect(res.json().subject).toBe("Your Kvitka Trade LLC filing");
  });

  /**
   * The check step answers **who**, not "what does it look like".
   *
   * It used to render the whole letter, which put a picture in competition with the only question
   * this screen exists for — and cost a logo read and a full shell render on every check. The
   * letter is still previewable in the template editor and the kind switcher.
   */
  it("answers who is about to be written to, not what the letter looks like", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mailouts/preview",
      headers: { cookie },
      payload: {
        letter: letter(),
        recipients: [
          { clientId: clientA },
          { clientId: clientA, companyId: kvitka },
          ...to(clientC),
        ],
      },
    });
    const body = res.json();

    expect(body.html).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("<table");

    // every row names its own address or its own reason — the counts are a summary of these
    expect(body.sendable).toBe(2);
    expect(body.blocked).toBe(1);
    expect(
      body.rows.map(
        (r: {
          companyName: string | null;
          email: string | null;
          blockedReason: string | null;
        }) => [r.companyName, r.email, r.blockedReason],
      ),
    ).toEqual([
      [null, "olena@example.com", null],
      ["Kvitka Payroll LLC", "office@kvitka.example", null],
      [null, null, "No email address on the client card"],
    ]);
  });

  it("surfaces a mistyped variable instead of silently deleting it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mailouts/preview",
      headers: { cookie },
      payload: {
        letter: letter({
          subject: "Due {{deadline}}",
          heading: null,
          body: "Hi {{first_name}}.",
        }),
        recipients: to(clientA),
      },
    });
    expect(res.json().unknownVariables).toEqual(["deadline"]);
  });
});

describe("previewing the letter itself", () => {
  const render = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/mailouts/preview/letter",
      headers: { cookie },
      payload,
    });

  /** Looking at your own layout must not require picking a recipient first. */
  it("renders the full letter with sample values and no clients", async () => {
    const res = await render(letter());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.subject).not.toContain("{{");
    expect(body.html).toContain("Maryna Onyshchenko"); // the signature block
    expect(body.html).toContain("#37544F"); // the brand colour
    expect(body.sendable).toBe(true);
    expect(testOutbox).toHaveLength(0);
  });

  it("shows the legal footer on commercial and omits it on transactional", async () => {
    const commercial = (await render(letter())).json();
    expect(commercial.html).toContain("Charlotte, NC 28202");
    expect(commercial.html).toContain("/unsubscribe/");

    const transactional = (await render(letter({ kind: "transactional" }))).json();
    expect(transactional.html).not.toContain("Charlotte, NC 28202");
    expect(transactional.html).not.toContain("/unsubscribe/");
  });

  /** Better to learn the send is blocked while writing than at the end of the composer. */
  it("warns up front when a commercial send would be refused for want of a postal address", async () => {
    await prisma.firmProfile.update({ where: { id: 1 }, data: { postalAddress: null } });

    const commercial = (await render(letter())).json();
    expect(commercial.sendable).toBe(false);
    expect(commercial.blockedReason).toMatch(/postal address/i);

    const transactional = (await render(letter({ kind: "transactional" }))).json();
    expect(transactional.sendable).toBe(true);

    await prisma.firmProfile.update({
      where: { id: 1 },
      data: { postalAddress: "1200 Main St, Suite 4, Charlotte, NC 28202" },
    });
  });

  it("names a mistyped variable", async () => {
    const res = await render(letter({ body: "Due {{deadlien}}", subject: "S", heading: null }));
    expect(res.json().unknownVariables).toEqual(["deadlien"]);
  });

  /**
   * The bug this pins: the shell hard-coded `cid:firm-logo`, which resolves against a letter's
   * ATTACHMENT. A browser preview has no attachment, so every preview drew a broken-image icon
   * while reporting that the letter had a logo. The preview must inline the bytes instead.
   */
  it("inlines the letterhead rather than pointing at an attachment the browser cannot see", async () => {
    const file = await prisma.file.create({
      data: {
        name: "letterhead.png",
        size: 4,
        mime: "image/png",
        path: "does-not-exist.png",
        uploadedById: (await prisma.user.findFirstOrThrow()).id,
      },
    });
    await prisma.firmProfile.update({ where: { id: 1 }, data: { mailLogoFileId: file.id } });

    try {
      const html = (await render(letter())).json().html;
      // the file is missing on disk, so it falls back to the wordmark rather than a dead cid:
      expect(html).not.toContain("cid:");
    } finally {
      // `finally`, because a failing assertion used to leave this row behind — and File points at
      // User, so the next run's teardown could not delete users and the whole suite collapsed
      await prisma.firmProfile.update({ where: { id: 1 }, data: { mailLogoFileId: null } });
      await prisma.file.delete({ where: { id: file.id } });
    }
  });

  it("returns both states of the highlight from one render", async () => {
    const body = (await render(letter())).json();
    expect(body.highlightedHtml).toContain("#fff3bf");
    expect(body.html).not.toContain("#fff3bf");
    // the same letter either way — only the marks differ
    expect(body.html).toContain("Kvitka Trade LLC");
    expect(body.highlightedHtml).toContain("Kvitka Trade LLC");
    expect(body.variablesUsed).toContain("company");
  });

  /**
   * The preview fences substituted values with private-use characters so it can colour them in.
   * Those characters must never reach a client: they are invisible in most fonts, so a leak would
   * be silent, and would sit in every letter the firm sends.
   */
  it("never leaks a highlight marker into a real send, or into the preview's plain html", async () => {
    const MARKS = /[]/;

    const preview = (await render(letter())).json();
    expect(MARKS.test(preview.html)).toBe(false);
    expect(MARKS.test(preview.subject)).toBe(false);

    const sent = await send({ letter: letter(), recipients: to(clientA) });
    await settled(sent.json().id);
    expect(testOutbox).toHaveLength(1);
    expect(MARKS.test(testOutbox[0].html)).toBe(false);
    expect(MARKS.test(testOutbox[0].text ?? "")).toBe(false);
    expect(MARKS.test(testOutbox[0].subject)).toBe(false);
  });
});

describe("templates", () => {
  it("refuses a duplicate name, case-insensitively", async () => {
    await app.inject({
      method: "POST",
      url: "/api/mailouts/templates",
      headers: { cookie },
      payload: { name: "Quarterly reminder", subject: "S", body: "B" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/mailouts/templates",
      headers: { cookie },
      payload: { name: "quarterly REMINDER", subject: "S", body: "B" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("will not delete a template a mailout still points at", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/mailouts/templates",
      headers: { cookie },
      payload: { name: "Used once", subject: "Hi {{first_name}}", body: "Body." },
    });
    const id = created.json().id;
    const sent = await send({ templateId: id, recipients: to(clientA) });
    await settled(sent.json().id);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/mailouts/templates/${id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/deactivate/i);
  });

  it("refuses to send an inactive template", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/mailouts/templates",
      headers: { cookie },
      payload: { name: "Retired", subject: "S", body: "B" },
    });
    const id = created.json().id;
    await app.inject({
      method: "PATCH",
      url: `/api/mailouts/templates/${id}`,
      headers: { cookie },
      payload: { active: false },
    });
    const res = await send({ templateId: id, recipients: to(clientA) });
    expect(res.statusCode).toBe(400);
  });
});

describe("the whole unsubscribe journey, as a client lives it", () => {
  /**
   * End to end, in the order it really happens: a client exists, gets a letter, clicks the link in
   * their own inbox, and the firm sees it on their card. Written after the firm reported that
   * unsubscribing changed nothing in the admin — the API was right, the browser was showing a
   * 30-second cache, and only a test that walks the whole path says which half is at fault.
   */
  it("send → the client clicks unsubscribe → the card says so → commercial mail stops", async () => {
    const fresh = await prisma.client.create({
      data: {
        firstName: "Testiy",
        lastName: "Unsub",
        companyName: "Test Co",
        email: "testiy@example.test",
      },
    });

    const cardState = async () =>
      (
        await app.inject({
          method: "GET",
          url: `/api/mailouts/clients/${fresh.id}`,
          headers: { cookie },
        })
      ).json();

    // 1. a brand-new client is subscribed, with no preference row at all
    expect((await cardState()).subscribed).toBe(true);

    // 2. a letter goes out, and the card shows it
    const sent = await send({
      letter: letter({ subject: "News", heading: null, body: "Hi {{first_name}}." }),
      recipients: to(fresh.id),
    });
    expect(sent.statusCode).toBe(201);
    await settled(sent.json().id);

    const afterSend = await cardState();
    expect(afterSend.history).toHaveLength(1);
    expect(afterSend.history[0].status).toBe("sent");

    // 3. the client clicks the link in the letter — no login, form-encoded, exactly as a browser
    const token = (
      await prisma.clientMailPreference.findUniqueOrThrow({
        where: { clientId: fresh.id },
      })
    ).token;
    const click = await app.inject({
      method: "POST",
      url: `/api/mailouts/unsubscribe/${token}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "",
    });
    expect(click.statusCode).toBe(200);

    // 4. the card reflects it, and names them as having done it themselves
    const afterClick = await cardState();
    expect(afterClick.subscribed).toBe(false);
    expect(afterClick.unsubscribedAt).toBeTruthy();
    expect(afterClick.unsubscribedByName).toBeNull();

    // 5. commercial mail now refuses them…
    testOutbox.length = 0;
    const refused = await send({
      letter: letter({ subject: "More news", heading: null, body: "Hi." }),
      recipients: to(fresh.id),
    });
    expect(refused.statusCode).toBe(400);
    expect(testOutbox).toHaveLength(0);

    // …6. while an invoice still reaches them. This is the whole reason `kind` is stored.
    const invoice = await send({
      letter: letter({
        kind: "transactional",
        subject: "Invoice",
        heading: null,
        body: "Due.",
      }),
      recipients: to(fresh.id),
    });
    expect(invoice.statusCode).toBe(201);
    await settled(invoice.json().id);
    expect(testOutbox).toHaveLength(1);

    // 7. and the firm can put them back, which is CRM-only
    const back = await app.inject({
      method: "PATCH",
      url: `/api/mailouts/clients/${fresh.id}/subscription`,
      headers: { cookie },
      payload: { subscribed: true },
    });
    expect(back.json().subscribed).toBe(true);

    await prisma.client.delete({ where: { id: fresh.id } });
  });
});

/**
 * The card lists RECIPIENT rows, so a letter is addressed by row id, not by mailout — one mailout
 * can reach the same client at their own address and at each of their companies.
 */
async function letterIdFor(
  clientId: string,
  mailoutId: string,
  companyId: string | null = null,
) {
  const state = await app.inject({
    method: "GET",
    url: `/api/mailouts/clients/${clientId}`,
    headers: { cookie },
  });
  const row = state
    .json()
    .history.find(
      (h: { mailoutId: string; companyId: string | null }) =>
        h.mailoutId === mailoutId && h.companyId === companyId,
    );
  if (!row) throw new Error(`no letter row for client=${clientId} mailout=${mailoutId}`);
  return row.id as string;
}

describe("one client's copy of a letter", () => {
  /**
   * The leak this closes: opening a letter from Olena's card showed Petro's name, address and skip
   * reason, because the card reused the mailout-level detail. Correct in the Mailouts log; a leak
   * on a client's own page.
   */
  it("shows only this client, with the letter rendered for them", async () => {
    const res = await send({ letter: letter(), recipients: to(clientA, clientB) });
    const mailoutId = res.json().id;
    await settled(mailoutId);

    const mine = await app.inject({
      method: "GET",
      url: `/api/mailouts/clients/${clientA}/letters/${await letterIdFor(clientA, mailoutId)}`,
      headers: { cookie },
    });
    expect(mine.statusCode).toBe(200);
    const body = mine.json();

    // rendered for THEM — not the stored snapshot with its {{vars}}
    expect(body.subject).toBe("Your Kvitka Trade LLC filing");
    expect(body.body).toContain("Dear Olena");
    expect(body.body).not.toContain("{{");
    expect(body.email).toBe("olena@example.com");
    expect(body.status).toBe("sent");

    // and nothing at all about the other recipient
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("Petro");
    expect(serialised).not.toContain("petro@example.com");
  });

  /**
   * The scope is in the URL, so asking for somebody else's row under your own client id is a 404
   * rather than a leak — the row simply does not match `(id, clientId)`.
   */
  it("refuses another client's row even when the letter id is real", async () => {
    const res = await send({
      letter: letter({ subject: "Only A", heading: null, body: "Hi." }),
      recipients: to(clientA),
    });
    const mailoutId = res.json().id;
    await settled(mailoutId);
    const theirLetter = await letterIdFor(clientA, mailoutId);

    const notMine = await app.inject({
      method: "GET",
      url: `/api/mailouts/clients/${clientC}/letters/${theirLetter}`,
      headers: { cookie },
    });
    expect(notMine.statusCode).toBe(404);
  });
});

describe("the client card", () => {
  it("shows the letters this client received", async () => {
    const res = await send({
      letter: letter({ subject: "Card history", heading: null, body: "Hi {{first_name}}." }),
      recipients: to(clientA),
    });
    await settled(res.json().id);

    const state = await app.inject({
      method: "GET",
      url: `/api/mailouts/clients/${clientA}`,
      headers: { cookie },
    });
    const body = state.json();
    expect(body.hasEmail).toBe(true);
    expect(body.history.some((h: { subject: string }) => h.subject === "Card history")).toBe(
      true,
    );
  });

  /**
   * The key that makes a bounce matchable at all.
   *
   * A DSN quotes the original `Message-ID` back in `References:`, so storing what nodemailer
   * reports is what ties a returned letter to the row that sent it — rather than guessing from the
   * address and a timestamp. It was being discarded.
   */
  it("keeps the Message-ID the letter went out with", async () => {
    const res = await send({
      letter: letter({ subject: "Keyed", heading: null, body: "Hi." }),
      recipients: to(clientA),
    });
    await settled(res.json().id);

    const rows = await prisma.mailoutRecipient.findMany({
      where: { mailoutId: res.json().id, status: "sent" },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.messageId).toMatch(/^<outbox-\d+@test\.local>$/);
    }
  });

  /**
   * The mailout row stores the template text with its `{{vars}}` intact — correct for a record of
   * one send to many people. On a client's own card it would show a letter nobody ever received,
   * so the subject is rendered for THAT client.
   */
  it("shows the subject as this client received it, not the raw template", async () => {
    const res = await send({ letter: letter(), recipients: to(clientA) });
    await settled(res.json().id);

    const state = await app.inject({
      method: "GET",
      url: `/api/mailouts/clients/${clientA}`,
      headers: { cookie },
    });
    const subjects = state.json().history.map((h: { subject: string }) => h.subject);
    expect(subjects).toContain("Your Kvitka Trade LLC filing");
    expect(subjects.some((s: string) => s.includes("{{"))).toBe(false);
  });

  /**
   * The card used to stop at a hard cap of 50 with nothing on screen saying so — a client on a
   * monthly campaign would silently lose their older letters, and the tab would read as though
   * they had never been sent. Paged now, which only helps if the page really is a WINDOW: the
   * count has to be of everything, and page 2 has to hold different letters from page 1.
   */
  it("pages the history, and counts every letter rather than the page", async () => {
    const state = (page: number, pageSize: number) =>
      app
        .inject({
          method: "GET",
          url: `/api/mailouts/clients/${clientB}?page=${page}&pageSize=${pageSize}`,
          headers: { cookie },
        })
        .then((r) => r.json());

    for (let i = 1; i <= 3; i++) {
      const res = await send({
        letter: letter({ subject: `Paged ${i}`, heading: null, body: "Hi." }),
        recipients: to(clientB),
      });
      await settled(res.json().id);
    }

    const all = await state(1, 25);
    expect(all.historyTotal).toBeGreaterThanOrEqual(3);

    const first = await state(1, 2);
    expect(first.history).toHaveLength(2);
    // The count must survive being asked for a small page — this is the assertion that fails if
    // `historyTotal` is ever computed from the rows in hand instead of from the table.
    expect(first.historyTotal).toBe(all.historyTotal);

    const second = await state(2, 2);
    const ids = (s: { history: { id: string }[] }) => s.history.map((h) => h.id);
    expect(second.history.length).toBeGreaterThan(0);
    expect(ids(second).some((id) => ids(first).includes(id))).toBe(false);

    // A count that forgot its `where` still satisfies everything above — and would put another
    // client's letters in this one's "Sent" chip. Writing to somebody else must not move it.
    const other = await send({
      letter: letter({ subject: "For a different client", heading: null, body: "Hi." }),
      recipients: to(clientA),
    });
    await settled(other.json().id);
    expect((await state(1, 25)).historyTotal).toBe(all.historyTotal);
  });

  /**
   * The bug paging introduced, and which sequential fixtures cannot show.
   *
   * One mailout to a client with two companies writes THREE rows in the same instant, so
   * `createdAt` alone is not a total order — and `OFFSET` over a tie is free to hand back a letter
   * already seen on the previous page while never showing another one at all. Proven on the dev
   * database before the fix: one row came back at both `OFFSET 0` and `OFFSET 2`.
   *
   * Asserted as a set rather than page by page, because the failure has two faces — a duplicate
   * and a disappearance — and counting distinct ids over the whole walk catches both.
   */
  it("walks every letter exactly once when several share an instant", async () => {
    const companies = await prisma.company.findMany({ where: { clientId: clientA } });
    expect(companies.length).toBeGreaterThan(1);

    const res = await send({
      letter: letter({ subject: "Same instant", heading: null, body: "Hi." }),
      recipients: [
        { clientId: clientA },
        ...companies.map((co) => ({ clientId: clientA, companyId: co.id })),
      ],
    });
    await settled(res.json().id);

    const page = (n: number) =>
      app
        .inject({
          method: "GET",
          url: `/api/mailouts/clients/${clientA}?page=${n}&pageSize=2`,
          headers: { cookie },
        })
        .then((r) => r.json());

    const total = (await page(1)).historyTotal;
    const seen: string[] = [];
    for (let n = 1; n <= Math.ceil(total / 2); n++) {
      seen.push(...(await page(n)).history.map((h: { id: string }) => h.id));
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });
});

/**
 * A client holds several companies, each with its own inbox.
 *
 * The rule the whole block is checking: **naming a company means writing to that company**. Not to
 * the person who owns it, not "to whichever address we can find" — a firm that asks to write to
 * Kvitka Trade and reaches Olena's personal inbox has sent the letter to the wrong place, and the
 * only honest alternative is to say it could not be sent.
 */
describe("writing to a client's companies", () => {
  it("reaches the company's own inbox, and names the company in the letter", async () => {
    const res = await send({ letter: letter(), recipients: toCompany(clientA, kvitka) });
    expect(res.statusCode).toBe(201);
    const rows = await settled(res.json().id);

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sent");
    expect(rows[0].email).toBe("office@kvitka.example");
    expect(rows[0].companyId).toBe(kvitka);

    const mail = testOutbox.at(-1)!;
    expect(mail.to).toBe("office@kvitka.example");
    // the COMPANY's name, not the "Kvitka Trade LLC" label on Olena's card
    expect(mail.subject).toBe("Your Kvitka Payroll LLC filing");
    expect(mail.subject).not.toContain("Kvitka Trade");
    // still greeted by the person who owns it — the company has no first name
    expect(mail.html).toContain("Olena");
  });

  /**
   * The important negative. Falling back to the client's address would "work" in the sense that a
   * letter arrives, which is exactly what makes it dangerous: a payroll letter meant for a
   * business would land in a personal inbox and nobody would ever be told.
   */
  it("skips a company with no inbox rather than redirecting to the client", async () => {
    const res = await send({ letter: letter(), recipients: toCompany(clientA, sonyachny) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/nobody on this list/i);
    expect(testOutbox).toHaveLength(0);
  });

  it("names the company in the skip reason, so the fix is obvious", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mailouts/preview",
      headers: { cookie },
      payload: { letter: letter(), recipients: toCompany(clientA, sonyachny) },
    });
    const row = res.json().rows[0];
    expect(row.blockedReason).toBe("No email address on Sonyachny FOP");
    expect(row.companyName).toBe("Sonyachny FOP");
    expect(row.clientName).toContain("Olena");
  });

  it("writes to a client and to their company in one send, as two letters", async () => {
    const res = await send({
      letter: letter(),
      recipients: [{ clientId: clientA }, { clientId: clientA, companyId: kvitka }],
    });
    const rows = await settled(res.json().id);

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "sent")).toBe(true);
    expect(new Set(rows.map((r) => r.email))).toEqual(
      new Set(["olena@example.com", "office@kvitka.example"]),
    );
    expect(testOutbox.map((m) => m.to).sort()).toEqual([
      "office@kvitka.example",
      "olena@example.com",
    ]);
    // and they are not the same letter: {{company}} names the card's label in one and the
    // company's own name in the other
    const byTo = new Map(testOutbox.map((m) => [m.to, m.subject]));
    expect(byTo.get("olena@example.com")).toBe("Your Kvitka Trade LLC filing");
    expect(byTo.get("office@kvitka.example")).toBe("Your Kvitka Payroll LLC filing");
  });

  it("refuses a company that belongs to somebody else", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mailouts/preview",
      headers: { cookie },
      payload: { letter: letter(), recipients: toCompany(clientA, petrosCompany) },
    });
    const row = res.json().rows[0];
    expect(row.blockedReason).toMatch(/no longer on this client/i);
    expect(row.email).toBeNull();
    // and nothing of Petro's leaks through the lookup
    expect(JSON.stringify(res.json())).not.toContain("ops@bond.example");
  });

  /**
   * Postgres treats NULLs as distinct, so `UNIQUE(mailoutId, clientId, companyId)` alone would let
   * the same client in twice with a NULL company — and the same addressee twice would otherwise
   * fail the WHOLE send on a constraint violation. Both are collapsed before the rows are written.
   */
  it("collapses an addressee named twice instead of failing the send", async () => {
    const res = await send({
      letter: letter(),
      recipients: [
        { clientId: clientA },
        { clientId: clientA, companyId: null },
        { clientId: clientA, companyId: kvitka },
        { clientId: clientA, companyId: kvitka },
      ],
    });
    expect(res.statusCode).toBe(201);
    const rows = await settled(res.json().id);
    expect(rows).toHaveLength(2);
  });

  /**
   * One opt-out, every address. The stricter reading, and the right one: a client who asked not to
   * hear from the firm did not mean "except at my other inbox".
   */
  it("honours the client's unsubscribe on their companies' inboxes too", async () => {
    const fresh = await prisma.client.create({
      data: {
        firstName: "Yulia",
        lastName: "Quiet",
        email: "yulia@example.com",
        companies: { create: [{ name: "Quiet Books LLC", email: "books@quiet.example" }] },
      },
      include: { companies: true },
    });
    const theirCompany = fresh.companies[0]!.id;

    await app.inject({
      method: "PATCH",
      url: `/api/mailouts/clients/${fresh.id}/subscription`,
      headers: { cookie },
      payload: { subscribed: false },
    });

    const blocked = await send({
      letter: letter({ subject: "News", heading: null, body: "Hi." }),
      recipients: toCompany(fresh.id, theirCompany),
    });
    expect(blocked.statusCode).toBe(400);
    expect(testOutbox).toHaveLength(0);

    // …and a transactional letter still gets through, to the company, unaffected by the opt-out
    const invoice = await send({
      letter: letter({ subject: "Invoice", heading: null, body: "Hi.", kind: "transactional" }),
      recipients: toCompany(fresh.id, theirCompany),
    });
    const rows = await settled(invoice.json().id);
    expect(rows[0].status).toBe("sent");
    expect(rows[0].email).toBe("books@quiet.example");

    await prisma.mailoutRecipient.deleteMany({ where: { clientId: fresh.id } });
    await prisma.clientMailPreference.deleteMany({ where: { clientId: fresh.id } });
    await prisma.company.deleteMany({ where: { clientId: fresh.id } });
    await prisma.client.delete({ where: { id: fresh.id } });
  });

  /**
   * The same rule the templates follow: a company that has been written to is part of the client's
   * history, so removing it from their card is refused with the count rather than quietly taking
   * the letters with it. The database enforces it (ON DELETE RESTRICT); this is the sentence.
   */
  it("refuses to remove a company that has been written to", async () => {
    const owner = await prisma.client.create({
      data: {
        firstName: "Taras",
        lastName: "Ledger",
        email: "taras@example.com",
        companies: { create: [{ name: "Ledger Works LLC", email: "hi@ledger.example" }] },
      },
      include: { companies: true },
    });

    const sent = await send({
      letter: letter({ subject: "Hi", heading: null, body: "Hi." }),
      recipients: toCompany(owner.id, owner.companies[0]!.id),
    });
    await settled(sent.json().id);

    // the client card's own save path — companies are a full replace of the list
    const save = await app.inject({
      method: "PATCH",
      url: `/api/clients/${owner.id}`,
      headers: { cookie },
      payload: { companies: [] },
    });
    expect(save.statusCode).toBe(409);
    expect(save.json().error.message).toMatch(/1 sent letter\(s\)/);

    // and the company is still there, with its letter
    expect(await prisma.company.count({ where: { clientId: owner.id } })).toBe(1);

    await prisma.mailoutRecipient.deleteMany({ where: { clientId: owner.id } });
    await prisma.clientMailPreference.deleteMany({ where: { clientId: owner.id } });
    await prisma.company.deleteMany({ where: { clientId: owner.id } });
    await prisma.client.delete({ where: { id: owner.id } });
  });

  it("lists every inbox the card can write to, the client's own first", async () => {
    const state = await app.inject({
      method: "GET",
      url: `/api/mailouts/clients/${clientA}`,
      headers: { cookie },
    });
    expect(state.json().targets).toEqual([
      { companyId: null, name: "Olena Kovalenko", email: "olena@example.com" },
      { companyId: kvitka, name: "Kvitka Payroll LLC", email: "office@kvitka.example" },
      { companyId: sonyachny, name: "Sonyachny FOP", email: null },
    ]);
  });

  it("tells the card which inbox each letter went to, and renders that letter", async () => {
    const res = await send({
      letter: letter({ subject: "To {{company}}", heading: null, body: "For {{company}}." }),
      recipients: [{ clientId: clientA }, { clientId: clientA, companyId: kvitka }],
    });
    const mailoutId = res.json().id;
    await settled(mailoutId);

    const state = await app.inject({
      method: "GET",
      url: `/api/mailouts/clients/${clientA}`,
      headers: { cookie },
    });
    const mine = state
      .json()
      .history.filter((h: { mailoutId: string }) => h.mailoutId === mailoutId);
    expect(mine).toHaveLength(2);
    expect(mine.map((h: { companyName: string | null }) => h.companyName).sort()).toEqual([
      "Kvitka Payroll LLC",
      null,
    ]);
    // and each row's subject is re-rendered for the inbox it went to — the company's row must not
    // read back with the client card's label, which is a different business entirely
    const subjects = Object.fromEntries(
      mine.map((h: { companyName: string | null; subject: string }) => [
        h.companyName ?? "own",
        h.subject,
      ]),
    );
    expect(subjects).toEqual({
      own: "To Kvitka Trade LLC",
      "Kvitka Payroll LLC": "To Kvitka Payroll LLC",
    });

    // the company's copy, opened from the card, is rendered with the COMPANY's values
    const letterId = await letterIdFor(clientA, mailoutId, kvitka);
    const one = await app.inject({
      method: "GET",
      url: `/api/mailouts/clients/${clientA}/letters/${letterId}`,
      headers: { cookie },
    });
    expect(one.statusCode).toBe(200);
    expect(one.json().companyName).toBe("Kvitka Payroll LLC");
    expect(one.json().email).toBe("office@kvitka.example");
    expect(one.json().body).toBe("For Kvitka Payroll LLC.");
  });
});

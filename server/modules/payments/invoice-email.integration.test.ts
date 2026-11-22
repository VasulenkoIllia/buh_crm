import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { invalidateAccessCache } from "../../core/access.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { prisma } from "../../core/db.js";
import { testOutbox } from "../../core/email.js";

/**
 * **Send by email** (payments.md §12, owner 2026-11-22): an invoice's PDF to the address its paper
 * prints, from the mailbox marked for invoices, with the template marked for them. The sent mark is
 * stamped once, the activity log says to whom, and every refusal is said before anything goes.
 */

const TAG = `ie${randomUUID().slice(0, 6)}`;
let app: Awaited<ReturnType<typeof buildApp>>;

interface Person {
  id: string;
  cookie: string;
}
let admin: Person;
let colleague: Person;
const people: string[] = [];
let clientId: string;
let mailboxId: string;
let templateId: string;
let previousInvoiceSender: string | null = null;
let previousInvoiceTemplate: string | null = null;

const SUBJECT = "Invoice {{invoice_number}} from {{firm_name}}";
const BODY =
  "Dear {{first_name}},\n\nInvoice {{invoice_number}} for {{amount}} is attached. " +
  "{{balance}} is due by {{due_date}}.";

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

async function person(role: "admin" | "user"): Promise<Person> {
  const email = `${role}-${TAG}@invoice-email.local`;
  const user = await prisma.user.create({
    data: {
      firstName: role,
      lastName: TAG,
      email,
      passwordHash: await argon2.hash("password-123"),
      role,
      status: "active",
    },
  });
  people.push(user.id);
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: "password-123" },
  });
  return { id: user.id, cookie: cookieOf(res) };
}

function as(who: Person) {
  const headers = { cookie: who.cookie };
  return {
    get: (url: string) => app.inject({ method: "GET", url, headers }),
    post: (url: string, payload?: object) =>
      app.inject({ method: "POST", url, headers, payload }),
    patch: (url: string, payload: object = {}) =>
      app.inject({ method: "PATCH", url, headers, payload }),
    delete: (url: string) => app.inject({ method: "DELETE", url, headers }),
  };
}

/** The log is written after the response, so an assertion on it waits. */
async function recorded(action: string, subjectId: string, since: Date) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const row = await prisma.activityEvent.findFirst({
      where: { action, subjectId, occurredAt: { gte: since } },
      orderBy: { occurredAt: "desc" },
    });
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`activity row never arrived: ${action} for ${subjectId}`);
}

async function makeClient(data: { email?: string | null; firstName?: string } = {}) {
  const client = await prisma.client.create({
    data: { firstName: `${TAG} ${data.firstName ?? "Olena"}`, email: data.email ?? null },
  });
  return client.id;
}

async function makeInvoice(payload: object = {}, client = clientId) {
  const res = await as(admin).post("/api/invoices", {
    clientId: client,
    amount: 45000,
    description: "Tax return",
    dueDate: "2026-12-15",
    ...payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string; number: string }>();
}

const emailOf = (id: string, who: Person = admin) => as(who).post(`/api/invoices/${id}/email`);
const previewOf = (id: string, who: Person = admin) => as(who).get(`/api/invoices/${id}/email`);

beforeAll(async () => {
  app = await buildApp();
  await ensureBaseData();
  admin = await person("admin");
  colleague = await person("user");
  clientId = await makeClient({ email: `olena-${TAG}@example.com` });

  // this suite's own mailbox and letter, so another suite's mailboxes and templates decide nothing
  previousInvoiceSender =
    (await prisma.mailSenderAccount.findFirst({ where: { isInvoiceSender: true } }))?.id ??
    null;
  previousInvoiceTemplate =
    (await prisma.emailTemplate.findFirst({ where: { isInvoiceTemplate: true } }))?.id ?? null;
  const mailbox = await prisma.mailSenderAccount.create({
    data: {
      name: `Billing ${TAG}`,
      fromName: "ILLION Billing",
      fromEmail: `billing-${TAG}@illion.test`,
      replyTo: `accounts-${TAG}@illion.test`,
    },
  });
  mailboxId = mailbox.id;
  await prisma.mailSenderAccount.updateMany({ data: { isInvoiceSender: false } });
  await prisma.mailSenderAccount.update({
    where: { id: mailboxId },
    data: { isInvoiceSender: true },
  });

  const template = await prisma.emailTemplate.create({
    data: { name: `Invoice letter ${TAG}`, subject: SUBJECT, body: BODY, kind: "commercial" },
  });
  templateId = template.id;
  // a commercial letter is not turned into the invoice one behind the firm's back
  const commercial = await as(admin).post(
    `/api/mailouts/templates/${templateId}/invoice-template`,
  );
  expect(commercial.statusCode).toBe(400);
  expect(commercial.json().error.message).toMatch(/Transactional first/);
  await prisma.emailTemplate.update({
    where: { id: templateId },
    data: { kind: "transactional" },
  });
  const marked = await as(admin).post(`/api/mailouts/templates/${templateId}/invoice-template`);
  expect(marked.statusCode).toBe(200);
});

beforeEach(() => {
  testOutbox.length = 0;
});

afterEach(async () => {
  await prisma.accessOverride.deleteMany({ where: { userId: { in: people } } });
  invalidateAccessCache();
});

afterAll(async () => {
  await prisma.campaign.deleteMany({ where: { name: { contains: TAG } } });
  const invoices = { client: { firstName: { startsWith: TAG } } };
  await prisma.invoiceLine.deleteMany({ where: { invoice: invoices } });
  await prisma.invoice.deleteMany({ where: invoices });
  await prisma.company.deleteMany({ where: { client: { firstName: { startsWith: TAG } } } });
  await prisma.client.deleteMany({ where: { firstName: { startsWith: TAG } } });
  await prisma.deadEmailAddress.deleteMany({ where: { email: { contains: TAG } } });

  await prisma.emailTemplate.updateMany({ data: { isInvoiceTemplate: false } });
  await prisma.emailTemplate.deleteMany({ where: { name: { contains: TAG } } });
  if (previousInvoiceTemplate) {
    await prisma.emailTemplate.update({
      where: { id: previousInvoiceTemplate },
      data: { isInvoiceTemplate: true },
    });
  }
  await prisma.mailSenderAccount.updateMany({ data: { isInvoiceSender: false } });
  await prisma.mailSenderAccount.delete({ where: { id: mailboxId } });
  if (previousInvoiceSender) {
    await prisma.mailSenderAccount.update({
      where: { id: previousInvoiceSender },
      data: { isInvoiceSender: true },
    });
  }
  await prisma.session.deleteMany({ where: { userId: { in: people } } });
  await prisma.activityEvent.deleteMany({ where: { actorUserId: { in: people } } });
  await prisma.user.deleteMany({ where: { id: { in: people } } });
  await app.close();
});

describe("the invoice template", () => {
  it("is one, marked from Templates, and transactional", async () => {
    const list = (await as(admin).get("/api/mailouts/templates")).json<
      { id: string; isInvoiceTemplate: boolean; kind: string }[]
    >();
    const marked = list.filter((t) => t.isInvoiceTemplate);
    expect(marked.map((t) => t.id)).toEqual([templateId]);
    expect(marked[0].kind).toBe("transactional");
  });

  it("moves when another one is marked, and the log says which", async () => {
    const since = new Date();
    const other = await prisma.emailTemplate.create({
      data: { name: `Other ${TAG}`, subject: "Hi", body: "Hello", kind: "transactional" },
    });
    expect(
      (await as(admin).post(`/api/mailouts/templates/${other.id}/invoice-template`)).statusCode,
    ).toBe(200);
    const row = await recorded("mailout.invoice_template_changed", other.id, since);
    expect(row.changes).toMatchObject({
      template: { from: `Invoice letter ${TAG}`, to: `Other ${TAG}` },
    });
    const first = await prisma.emailTemplate.findUniqueOrThrow({ where: { id: templateId } });
    expect(first.isInvoiceTemplate).toBe(false);

    await as(admin).post(`/api/mailouts/templates/${templateId}/invoice-template`);
    await prisma.emailTemplate.delete({ where: { id: other.id } });
  });

  it("is not switched off, deleted or made commercial while it is the one", async () => {
    const url = `/api/mailouts/templates/${templateId}`;
    expect((await as(admin).patch(url, { active: false })).statusCode).toBe(409);
    expect((await as(admin).patch(url, { kind: "commercial" })).statusCode).toBe(400);
    expect((await as(admin).delete(url)).statusCode).toBe(409);
    // the text itself is the firm's to change, and a PATCH that names no kind keeps the kind
    const edited = await as(admin).patch(url, { subject: SUBJECT });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ kind: "transactional" });
  });

  it("does not go out as an ordinary mailout", async () => {
    const res = await as(admin).post("/api/mailouts/send", {
      templateId,
      recipients: [{ clientId }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/invoice template/);
  });

  it("is not scheduled by a campaign, and one a campaign holds cannot be marked", async () => {
    const campaign = {
      name: `Campaign ${TAG}`,
      kind: "transactional",
      startsOn: "2027-01-10",
      recipients: [{ clientId }],
    };
    const refused = await as(admin).post("/api/mailouts/campaigns", {
      ...campaign,
      templateId,
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toMatch(/invoice template/);

    const held = await prisma.emailTemplate.create({
      data: { name: `Held ${TAG}`, subject: "Hi", body: "Hello", kind: "transactional" },
    });
    const created = await as(admin).post("/api/mailouts/campaigns", {
      ...campaign,
      templateId: held.id,
    });
    expect(created.statusCode).toBe(201);
    const marked = await as(admin).post(`/api/mailouts/templates/${held.id}/invoice-template`);
    expect(marked.statusCode).toBe(409);
    expect(marked.json().error.message).toMatch(/held by 1 campaign/);

    const asleep = await prisma.emailTemplate.create({
      data: {
        name: `Asleep ${TAG}`,
        subject: "Hi",
        body: "Hello",
        kind: "transactional",
        active: false,
      },
    });
    const inactive = await as(admin).post(
      `/api/mailouts/templates/${asleep.id}/invoice-template`,
    );
    expect(inactive.statusCode).toBe(400);

    await prisma.campaign.deleteMany({ where: { name: `Campaign ${TAG}` } });
  });

  it("knows the invoice variables in its preview, and an ordinary letter does not", async () => {
    const letter = { subject: SUBJECT, body: BODY, kind: "transactional" };
    const asInvoice = (
      await as(admin).post("/api/mailouts/preview/letter", {
        ...letter,
        isInvoiceTemplate: true,
      })
    ).json<{ unknownVariables: string[]; html: string; sender: { name: string } }>();
    expect(asInvoice.unknownVariables).toEqual([]);
    expect(asInvoice.html).toContain("INV-2026-0042");
    expect(asInvoice.sender.name).toBe(`Billing ${TAG}`);

    const ordinary = (await as(admin).post("/api/mailouts/preview/letter", letter)).json<{
      unknownVariables: string[];
    }>();
    expect(ordinary.unknownVariables).toEqual([
      "invoice_number",
      "amount",
      "balance",
      "due_date",
    ]);
  });
});

describe("Send by email", () => {
  it("shows what it will send before it sends", async () => {
    const invoice = await makeInvoice();
    const res = await previewOf(invoice.id, colleague);
    expect(res.statusCode).toBe(200);
    const preview = res.json();
    expect(preview).toMatchObject({
      to: `olena-${TAG}@example.com`,
      mailbox: { name: `Billing ${TAG}` },
      subject: `Invoice ${invoice.number} from ILLION Billing`,
      blockedReason: null,
    });
    expect(preview.mailbox.from).toContain(`billing-${TAG}@illion.test`);
    expect(preview.fileName).toMatch(/^invoice_.*\.pdf$/);
    expect(preview.html).toContain("$450.00");
    expect(preview.html).toContain("Dec-15-2026");
    expect(testOutbox).toHaveLength(0);
  });

  it("sends the PDF from the invoice mailbox, stamps sent and says so in the log", async () => {
    const invoice = await makeInvoice();
    const since = new Date();
    const res = await emailOf(invoice.id, colleague);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ delivery: "sent", sentByName: `user ${TAG}` });

    expect(testOutbox).toHaveLength(1);
    const mail = testOutbox[0];
    expect(mail.to).toBe(`olena-${TAG}@example.com`);
    expect(mail.subject).toBe(`Invoice ${invoice.number} from ILLION Billing`);
    expect(mail.from).toContain(`billing-${TAG}@illion.test`);
    expect(mail.replyTo).toBe(`accounts-${TAG}@illion.test`);
    expect(mail.html).toContain("$450.00");
    // transactional: no unsubscribe link and no postal address
    expect(mail.html).not.toContain("/unsubscribe/");
    const pdf = mail.attachments?.find((a) => a.contentType === "application/pdf");
    expect(pdf?.filename).toMatch(/^invoice_.*\.pdf$/);
    expect(pdf?.size).toBeGreaterThan(1000);

    const row = await recorded("invoice.emailed", invoice.id, since);
    expect(row.changes).toMatchObject({
      to: `olena-${TAG}@example.com`,
      mailbox: `Billing ${TAG}`,
    });
  });

  it("sent again, sends again and keeps the first sent date", async () => {
    const invoice = await makeInvoice();
    await emailOf(invoice.id);
    const first = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect((await emailOf(invoice.id, colleague)).statusCode).toBe(200);
    const second = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(testOutbox).toHaveLength(2);
    expect(second.sentAt).toEqual(first.sentAt);
    expect(second.sentById).toBe(admin.id);
  });

  it("sends once when pressed twice at the same moment", async () => {
    const invoice = await makeInvoice();
    const answers = await Promise.all([emailOf(invoice.id), emailOf(invoice.id)]);
    expect(answers.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(testOutbox).toHaveLength(1);
  });

  it("keeps a mark made by hand", async () => {
    const invoice = await makeInvoice();
    await as(colleague).post(`/api/invoices/${invoice.id}/delivery`, { sent: true });
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    await emailOf(invoice.id);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.sentAt).toEqual(before.sentAt);
    expect(after.sentById).toBe(colleague.id);
  });

  it("goes to the company's address, and to the client's when the company has none", async () => {
    const company = await prisma.company.create({
      data: { clientId, name: `${TAG} Kvitka LLC`, email: `office-${TAG}@kvitka.example` },
    });
    const bare = await prisma.company.create({ data: { clientId, name: `${TAG} Bare LLC` } });

    await emailOf((await makeInvoice({ companyId: company.id })).id);
    await emailOf((await makeInvoice({ companyId: bare.id })).id);
    expect(testOutbox.map((m) => m.to)).toEqual([
      `office-${TAG}@kvitka.example`,
      `olena-${TAG}@example.com`,
    ]);
  });

  /** owner, 2026-11-22: the due date is the one invoice value a letter may go without */
  it("goes without a due date, the date left empty", async () => {
    const invoice = await makeInvoice({ dueDate: null });
    const preview = (await previewOf(invoice.id)).json<{ blockedReason: string | null }>();
    expect(preview.blockedReason).toBeNull();
    expect((await emailOf(invoice.id)).statusCode).toBe(200);
    expect(testOutbox[0].text).toContain("is due by .");
  });

  it("reaches a client who unsubscribed from news", async () => {
    const unsubscribed = await makeClient({
      email: `quiet-${TAG}@example.com`,
      firstName: "Q",
    });
    await prisma.clientMailPreference.create({
      data: { clientId: unsubscribed, unsubscribedAt: new Date(), token: `tok-${TAG}-quiet` },
    });
    const res = await emailOf((await makeInvoice({}, unsubscribed)).id);
    expect(res.statusCode).toBe(200);
    expect(testOutbox.map((m) => m.to)).toEqual([`quiet-${TAG}@example.com`]);
  });

  it("is open to whoever has Billing, and closed with it", async () => {
    const invoice = await makeInvoice();
    await prisma.accessOverride.create({
      data: { userId: colleague.id, gate: "billing", state: "closed" },
    });
    invalidateAccessCache();
    expect((await emailOf(invoice.id, colleague)).statusCode).toBe(403);
    expect((await previewOf(invoice.id, colleague)).statusCode).toBe(403);
    expect(testOutbox).toHaveLength(0);
  });
});

/** Every refusal is said in the window first, then by the send, and nothing goes out. */
describe("what stops Send by email", () => {
  async function refused(invoiceId: string, reason: RegExp) {
    const preview = (await previewOf(invoiceId)).json<{ blockedReason: string | null }>();
    expect(preview.blockedReason).toMatch(reason);
    const res = await emailOf(invoiceId);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(reason);
    expect(testOutbox).toHaveLength(0);
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(row.sentAt).toBeNull();
  }

  it("a cancelled invoice", async () => {
    const invoice = await makeInvoice();
    expect((await as(admin).post(`/api/invoices/${invoice.id}/cancel`)).statusCode).toBe(200);
    await refused(invoice.id, /cancelled/);
  });

  it("an archived client", async () => {
    const archived = await makeClient({ email: `gone-${TAG}@example.com`, firstName: "Gone" });
    const invoice = await makeInvoice({}, archived);
    await prisma.client.update({ where: { id: archived }, data: { archivedAt: new Date() } });
    await refused(invoice.id, /archived/);
  });

  it("no address on the card", async () => {
    const silent = await makeClient({ firstName: "NoMail" });
    await refused((await makeInvoice({}, silent)).id, /No email address on the client card/);
  });

  it("an address a server said is gone", async () => {
    const email = `dead-${TAG}@example.com`;
    const dead = await makeClient({ email, firstName: "Dead" });
    await prisma.deadEmailAddress.create({
      data: { email, code: "5.1.1", reason: "no such mailbox" },
    });
    await refused((await makeInvoice({}, dead)).id, /Address rejected .* no such mailbox/);
  });

  it("a value the letter names and the card has none for", async () => {
    const invoice = await makeInvoice();
    await prisma.emailTemplate.update({
      where: { id: templateId },
      data: { body: `${BODY}\n\nWe will call you at {{phone}}.` },
    });
    try {
      await refused(invoice.id, /Client card has no \{\{phone\}\}/);
    } finally {
      await prisma.emailTemplate.update({ where: { id: templateId }, data: { body: BODY } });
    }
  });

  it("no mailbox marked for invoices", async () => {
    const invoice = await makeInvoice();
    await prisma.mailSenderAccount.update({
      where: { id: mailboxId },
      data: { isInvoiceSender: false },
    });
    try {
      await refused(invoice.id, /No mailbox sends invoices/);
    } finally {
      await prisma.mailSenderAccount.update({
        where: { id: mailboxId },
        data: { isInvoiceSender: true },
      });
    }
  });

  it("no template marked for invoices", async () => {
    const invoice = await makeInvoice();
    await prisma.emailTemplate.update({
      where: { id: templateId },
      data: { isInvoiceTemplate: false },
    });
    try {
      await refused(invoice.id, /No letter is set for invoices/);
    } finally {
      await prisma.emailTemplate.update({
        where: { id: templateId },
        data: { isInvoiceTemplate: true },
      });
    }
  });

  /**
   * The mailbox cannot send: its sealed password no key opens, the shape a rotated SECRETS_KEY
   * leaves. The window says so before anybody presses Send, and nothing is marked or logged.
   */
  it("a mailbox whose password cannot be opened", async () => {
    const invoice = await makeInvoice();
    await prisma.mailSenderAccount.update({
      where: { id: mailboxId },
      data: {
        smtpHost: "mail.example.com",
        smtpPort: 587,
        smtpPass: Buffer.from("not really encrypted"),
        smtpPassIv: Buffer.from("0123456789ab"),
        smtpPassTag: Buffer.from("0123456789abcdef"),
        smtpKeyVersion: 1,
      },
    });
    try {
      const since = new Date();
      await refused(invoice.id, /password cannot be opened/);
      const logged = await prisma.activityEvent.count({
        where: { action: "invoice.emailed", subjectId: invoice.id, occurredAt: { gte: since } },
      });
      expect(logged).toBe(0);
    } finally {
      await prisma.mailSenderAccount.update({
        where: { id: mailboxId },
        data: {
          smtpHost: null,
          smtpPort: null,
          smtpPass: null,
          smtpPassIv: null,
          smtpPassTag: null,
        },
      });
    }
  });
});

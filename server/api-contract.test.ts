import argon2 from "argon2";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { campaignDetailSchema, campaignListSchema } from "@shared/schema/campaigns.js";
import { clientSchema } from "@shared/schema/client.js";
import { paginated } from "@shared/schema/common.js";
import {
  clientMailStateSchema,
  mailoutDetailSchema,
  mailoutListSchema,
  mailSenderStateSchema,
} from "@shared/schema/mailouts.js";
import { invoiceListSchema, invoiceSchema } from "@shared/schema/payment.js";
import { serviceSchema } from "@shared/schema/catalog.js";
import { buildApp } from "./app.js";
import { prisma } from "./core/db.js";

/**
 * **The API keeps its promises.**
 *
 * Every screen types itself against a zod schema in `shared/schema/`, and until this file nothing
 * checked that the server actually SENDS what those schemas describe. Fastify validates request
 * bodies, never responses; most DTO mappers carry no explicit return type, so a field added to a
 * schema and forgotten in its mapper compiles cleanly on both sides and arrives as `undefined` at
 * runtime — a class of bug that neither `tsc` nor any existing test can see.
 *
 * So: call the real endpoint and parse the real response with the real schema. `.strict()` is
 * deliberately NOT used — an extra field the schema does not mention is harmless, a missing one is
 * not. What this catches is the promise the frontend is built on being quietly broken.
 */

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;
let clientId: string;
let invoiceId: string;
let campaignId: string;
let mailoutId: string;

/** Parse, and on failure say WHICH field broke rather than dumping the whole payload. */
function keeps<T extends z.ZodTypeAny>(schema: T, body: unknown, what: string) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join(" · ");
    throw new Error(`${what} does not match its schema — ${issues}`);
  }
}

const get = async (url: string) =>
  (await app.inject({ method: "GET", url, headers: { cookie } })).json();

beforeAll(async () => {
  app = await buildApp();
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
  await prisma.file.deleteMany();
  await prisma.user.deleteMany();

  await prisma.firmProfile.create({
    data: { id: 1, name: "ILLION", postalAddress: "1200 Main St, Charlotte, NC" },
  });
  await prisma.mailSenderAccount.create({
    data: { name: "Main", fromName: "ILLION", fromEmail: "info@illion.tax", isDefault: true },
  });
  await prisma.user.create({
    data: {
      email: "contract@test.local",
      passwordHash: await argon2.hash("password-123"),
      firstName: "Con",
      lastName: "Tract",
      role: "admin",
      status: "active",
    },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "contract@test.local", password: "password-123" },
  });
  const raw = login.headers["set-cookie"];
  cookie = (Array.isArray(raw) ? raw[0] : (raw as string)).split(";")[0];

  // one of everything, with the shapes that only appear when a feature is actually used:
  // a company recipient, invoice positions, a campaign on set dates.
  const client = await prisma.client.create({
    data: {
      firstName: "Olena",
      lastName: "K",
      email: "olena@example.com",
      companies: { create: [{ name: "Kvitka LLC", email: "office@kvitka.example", order: 0 }] },
    },
  });
  clientId = client.id;

  const template = (
    await app.inject({
      method: "POST",
      url: "/api/mailouts/templates",
      headers: { cookie },
      payload: { name: "News", subject: "Hi {{first_name}}", body: "Hello." },
    })
  ).json();

  mailoutId = (
    await app.inject({
      method: "POST",
      url: "/api/mailouts/send",
      headers: { cookie },
      payload: { templateId: template.id, recipients: [{ clientId }] },
    })
  ).json().id;

  campaignId = (
    await app.inject({
      method: "POST",
      url: "/api/mailouts/campaigns",
      headers: { cookie },
      payload: {
        name: "Season",
        templateId: template.id,
        rhythm: "dates",
        startsOn: "2099-03-15",
        dates: ["2099-03-15", "2099-09-15"],
        recipients: [{ clientId }],
      },
    })
  ).json().id;

  invoiceId = (
    await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { cookie },
      payload: {
        clientId,
        amount: 100_00,
        lines: [
          { description: "Consultation", quantity: 250, unitRate: 200_00, amount: 1 },
          { description: "Postage", amount: 15_00 },
        ],
      },
    })
  ).json().id;
});

afterAll(async () => {
  // Clear what this suite created. The files share one database and run in order, so a campaign
  // left pointing at a template makes the NEXT suite's `emailTemplate.deleteMany()` fail — which
  // is exactly how it reads as a bug in whatever runs next.
  await prisma.invoiceLine.deleteMany();
  await prisma.mailoutRecipient.deleteMany();
  await prisma.mailout.deleteMany();
  await prisma.campaignRecipient.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.emailTemplate.deleteMany();
  await app.close();
});

describe("the API sends what the screens are typed against", () => {
  /**
   * Built here rather than imported, because this one endpoint has no shared schema: the browser
   * types it with a hand-written `ClientListResponse` interface of its own, so nothing links the
   * two ends. This spells out what that interface expects and holds the server to it.
   */
  const clientListShape = paginated(clientSchema).extend({
    counts: z.object({ regular: z.number().int(), one_time: z.number().int() }),
  });

  it("clients", async () => {
    keeps(clientListShape, await get("/api/clients?tab=all"), "GET /api/clients");
    keeps(clientSchema, await get(`/api/clients/${clientId}`), "GET /api/clients/:id");
  });

  it("catalog", async () => {
    keeps(z.array(serviceSchema), await get("/api/catalog"), "GET /api/catalog");
  });

  it("invoices — including the positions added on 2026-08-20", async () => {
    keeps(invoiceListSchema, await get("/api/invoices"), "GET /api/invoices");
    const one = await get(`/api/invoices/${invoiceId}`);
    keeps(invoiceSchema, one, "GET /api/invoices/:id");
    expect(one.lines).toHaveLength(2);
    expect(one.amount).toBe(515_00); // 2.50 h × 200.00 + 15.00
  });

  it("mailouts", async () => {
    keeps(mailoutListSchema, await get("/api/mailouts"), "GET /api/mailouts");
    keeps(mailoutDetailSchema, await get(`/api/mailouts/${mailoutId}`), "GET /api/mailouts/:id");
    keeps(mailSenderStateSchema, await get("/api/mailouts/settings/senders"), "GET senders");
  });

  it("campaigns", async () => {
    keeps(campaignListSchema, await get("/api/mailouts/campaigns"), "GET campaigns");
    keeps(
      campaignDetailSchema,
      await get(`/api/mailouts/campaigns/${campaignId}`),
      "GET campaigns/:id",
    );
  });

  it("a client's mail state — history, targets, campaigns and the opt-out source", async () => {
    keeps(
      clientMailStateSchema,
      await get(`/api/mailouts/clients/${clientId}`),
      "GET mailouts/clients/:id",
    );
  });
});

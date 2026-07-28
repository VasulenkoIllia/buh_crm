import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { prisma } from "../../core/db.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

beforeAll(async () => {
  app = await buildApp();
  await prisma.session.deleteMany();
  await prisma.authToken.deleteMany();
  await prisma.timeEntry.deleteMany();
  await prisma.subtask.deleteMany();
  await prisma.taskAssignee.deleteMany();
  await prisma.task.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.file.deleteMany();
  await prisma.clientPerson.deleteMany();
  await prisma.company.deleteMany();
  await prisma.client.deleteMany();
  await prisma.user.deleteMany();

  await prisma.user.create({
    data: {
      firstName: "Test",
      lastName: "User",
      email: "user@clients.local",
      passwordHash: await argon2.hash("password-123"),
      role: "user",
      status: "active",
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "user@clients.local", password: "password-123" },
  });
  cookie = cookieOf(res);
});

afterAll(async () => {
  // this suite now creates tasks + invoices (company-dimension and archive cases) — leave the
  // database as clean as we found it, or the next suite trips over the foreign keys
  await prisma.payment.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.taskAssignee.deleteMany();
  await prisma.subtask.deleteMany();
  await prisma.task.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.company.deleteMany();
  await prisma.client.deleteMany();
  await prisma.service.deleteMany();
  await app.close();
});

describe("clients", () => {
  let individualId: string;

  it("creates a client with companies + people", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: {
        firstName: "Ivan",
        lastName: "Petrenko",
        phone: "+380501112233",
        email: "ivan@example.com",
        companies: [{ name: "Alpha LLC" }, { name: "Beta Inc" }],
        people: [{ name: "Olena Book", serviceLabel: "Bookkeeping", phone: "+380671110000" }],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    individualId = body.id;
    expect(body.displayName).toBe("Ivan Petrenko");
    expect(body.companies.map((c: { name: string }) => c.name)).toEqual(["Alpha LLC", "Beta Inc"]);
    expect(body.people).toHaveLength(1);
    expect(body.people[0]).toMatchObject({ name: "Olena Book", serviceLabel: "Bookkeeping" });
    expect(body.isRegular).toBe(false);
    expect(body.debt).toBe(0);
  });

  // the last name is optional (user, 2026-07-26) — a first name alone identifies the client
  it("accepts a client with only a first name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: { firstName: "Lesya", email: "lesya@example.com" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.lastName).toBeNull();
    expect(body.displayName).toBe("Lesya"); // no trailing space from the missing half
  });

  it("rejects a client with no first name at all", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: { lastName: "Petrenko", email: "x@example.com" },
    });
    expect(res.statusCode).toBe(400);
  });

  // an edit must not be able to strip the name either — the merged check runs on PATCH
  it("rejects clearing the first name on an existing client", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: { firstName: "Olha", lastName: "Koval" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/clients/${created.json().id}`,
      headers: { cookie },
      payload: { firstName: null },
    });
    expect(res.statusCode).toBe(400);
  });

  it("lets an edit drop the last name", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: { firstName: "Ihor", lastName: "Bondar" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/clients/${created.json().id}`,
      headers: { cookie },
      payload: { lastName: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe("Ihor");
  });

  // `companyName` is a plain label now — it never was, and never becomes, a Company row
  it("keeps companyName as a label, separate from the client's companies", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: {
        companyName: "Romashka LLC",
        firstName: "Petro",
        lastName: "Tkach",
        companies: [{ name: "Romashka Trade LLC" }],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.displayName).toBe("Petro Tkach"); // the person, never the label
    expect(body.companyName).toBe("Romashka LLC");
    expect(body.companies.map((c: { name: string }) => c.name)).toEqual(["Romashka Trade LLC"]);
  });

  it("a company belongs to exactly one client", async () => {
    // Ivan(2) + Romashka Trade(1) = 3 rows total
    expect(await prisma.company.count()).toBe(3);
    const alphas = await prisma.company.findMany({ where: { name: "Alpha LLC" } });
    expect(alphas).toHaveLength(1);
    expect(alphas[0].clientId).toBe(individualId);
  });

  // a company name identifies ONE company for the whole firm (user, 2026-07-26)
  it("refuses a company name another client already holds, and says who", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      // different case on purpose — the rule is case-insensitive
      payload: { firstName: "Copycat", companies: [{ name: "alpha llc" }] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain("Ivan Petrenko");
    // and the refused create left NOTHING behind — the name is checked before anything is written
    expect(await prisma.client.count({ where: { firstName: "Copycat" } })).toBe(0);
  });

  it("stores a company's own contact details and keeps its id across a rename", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: {
        firstName: "Detail",
        companies: [
          {
            name: "Detailed Co",
            phone: "+380671234567",
            email: "billing@detailed.co",
            description: "invoices go to accounting",
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const company = created.json().companies[0];
    expect(company).toMatchObject({
      name: "Detailed Co",
      phone: "+380671234567",
      email: "billing@detailed.co",
      description: "invoices go to accounting",
    });

    // renaming by id keeps the same row, so anything pointing at it follows along
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/clients/${created.json().id}`,
      headers: { cookie },
      payload: { companies: [{ id: company.id, name: "Detailed Group", email: "ap@detailed.co" }] },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().companies[0].id).toBe(company.id);
    expect(renamed.json().companies[0].name).toBe("Detailed Group");
    expect(renamed.json().companies[0].email).toBe("ap@detailed.co");
    // an OMITTED field is left alone (2026-07-28). It used to be cleared, which meant saving the
    // client's profile form — whose tag input carries names and nothing else — wiped every
    // company's phone, email and description, the invoice address among them.
    expect(renamed.json().companies[0].phone).toBe("+380671234567");
    expect(renamed.json().companies[0].description).toBe("invoices go to accounting");

    // …and that is exactly the shape the profile form sends: bare names, no details
    const profileSave = await app.inject({
      method: "PATCH",
      url: `/api/clients/${created.json().id}`,
      headers: { cookie },
      payload: { phone: "+380991110000", companies: [{ name: "Detailed Group" }] },
    });
    expect(profileSave.statusCode).toBe(200);
    expect(profileSave.json().companies[0]).toMatchObject({
      id: company.id,
      phone: "+380671234567",
      email: "ap@detailed.co",
      description: "invoices go to accounting",
    });

    // an EXPLICIT null still clears — that's how the Companies tab empties a field
    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/clients/${created.json().id}`,
      headers: { cookie },
      payload: { companies: [{ id: company.id, name: "Detailed Group", phone: null }] },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().companies[0].phone).toBeNull();
    expect(cleared.json().companies[0].email).toBe("ap@detailed.co"); // untouched
  });

  it("searches by company name", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/clients?tab=one_time&search=beta",
      headers: { cookie },
    });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].displayName).toBe("Ivan Petrenko");
  });

  it("a partial update keeps companies + people untouched", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/clients/${individualId}`,
      headers: { cookie },
      payload: { address: "Kyiv" }, // no companies/people -> must not touch them
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().companies).toHaveLength(2);
    expect(res.json().people).toHaveLength(1);
  });

  it("cannot blank a client's name via a partial update", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/clients/${individualId}`,
      headers: { cookie },
      payload: { firstName: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  /**
   * "Regular" is not a setting (user, 2026-07-26): it follows from the services the client holds.
   * A subscription-type service makes them regular; stopping it makes them one-time again — and
   * a one-time service never counts, however many of them there are.
   */
  it("derives regular from the subscriptions, and follows them both ways", async () => {
    const client = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: { firstName: "Derived", lastName: "Regular" },
    });
    const clientId = client.json().id;
    expect(client.json().isRegular).toBe(false);

    const [oneTime, monthly] = await Promise.all([
      prisma.service.create({ data: { name: "Derived one-off", color: "#000", type: "one_time" } }),
      prisma.service.create({ data: { name: "Derived monthly", color: "#000", type: "subscription" } }),
    ]);

    // a one-time service is only a container for ad-hoc jobs — it never makes anyone regular
    const withOneTime = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie },
      payload: { serviceId: oneTime.id, amount: 5000 },
    });
    expect(withOneTime.json().isRegular).toBe(false);

    const withSub = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie },
      payload: { serviceId: monthly.id, amount: 10_000, period: "month" },
    });
    expect(withSub.json().isRegular).toBe(true);
    const subId = withSub
      .json()
      .subscriptions.find((s: { serviceId: string }) => s.serviceId === monthly.id).id;

    // …and stopping it hands them straight back to One-time, with nothing to un-tick
    const stopped = await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/subscriptions/${subId}`,
      headers: { cookie },
      payload: { active: false },
    });
    expect(stopped.json().isRegular).toBe(false);

    // the tab filters agree with the DTO — they are the same rule, expressed in SQL
    const oneTimeTab = await app.inject({
      method: "GET",
      url: "/api/clients?tab=one_time&search=Derived",
      headers: { cookie },
    });
    expect(oneTimeTab.json().items.map((c: { id: string }) => c.id)).toContain(clientId);

    await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/subscriptions/${subId}`,
      headers: { cookie },
      payload: { active: true },
    });
    const regularTab = await app.inject({
      method: "GET",
      url: "/api/clients?tab=regular&search=Derived",
      headers: { cookie },
    });
    expect(regularTab.json().items.map((c: { id: string }) => c.id)).toContain(clientId);
  });

  it("rejects a whitespace-only person name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: {
        firstName: "A",
        lastName: "B",
        email: "ws@example.com",
        people: [{ name: "   " }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  /**
   * One of a client's services is "the usual one" (user, 2026-07-26). With a single service that
   * is automatic; with several the firm picks. At most one, and it can't be stopped while it
   * holds the flag — clear it first.
   */
  it("keeps exactly one default service per client, and guards it", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: { firstName: "Default", lastName: "Service" },
    });
    const clientId = created.json().id;
    const [first, second] = await Promise.all([
      prisma.service.create({ data: { name: "Default first", color: "#000", type: "subscription" } }),
      prisma.service.create({ data: { name: "Default second", color: "#000", type: "subscription" } }),
    ]);

    // the first service is the default by itself — with one option there is nothing to choose
    const one = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie },
      payload: { serviceId: first.id, amount: 1000, period: "month" },
    });
    const subA = one.json().subscriptions.find((s: { serviceId: string }) => s.serviceId === first.id);
    expect(subA.isDefault).toBe(true);

    // a second service does NOT steal the flag
    const two = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie },
      payload: { serviceId: second.id, amount: 2000, period: "month" },
    });
    const subB = two.json().subscriptions.find((s: { serviceId: string }) => s.serviceId === second.id);
    expect(subB.isDefault).toBe(false);

    // the default can't be stopped while it holds the flag
    const blocked = await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/subscriptions/${subA.id}`,
      headers: { cookie },
      payload: { active: false },
    });
    expect(blocked.statusCode).toBe(409);

    // moving it clears the previous holder — never two at once
    const moved = await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/subscriptions/${subB.id}`,
      headers: { cookie },
      payload: { isDefault: true },
    });
    const subs = moved.json().subscriptions;
    expect(subs.filter((s: { isDefault: boolean }) => s.isDefault)).toHaveLength(1);
    expect(subs.find((s: { id: string }) => s.id === subB.id).isDefault).toBe(true);

    // …and now the first one is free to stop
    const stopped = await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/subscriptions/${subA.id}`,
      headers: { cookie },
      payload: { active: false },
    });
    expect(stopped.statusCode).toBe(200);

    // clearing the flag entirely is allowed — that's how you stop the last service
    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/subscriptions/${subB.id}`,
      headers: { cookie },
      payload: { isDefault: false },
    });
    expect(cleared.json().subscriptions.every((s: { isDefault: boolean }) => !s.isDefault)).toBe(true);
    const lastStop = await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/subscriptions/${subB.id}`,
      headers: { cookie },
      payload: { active: false },
    });
    expect(lastStop.statusCode).toBe(200);
  });

  // the two tabs partition every client: there is no third state and no manual override
  it("the tabs split every client between them, with no overlap", async () => {
    const [regular, oneTime] = await Promise.all([
      app.inject({ method: "GET", url: "/api/clients?tab=regular&pageSize=100", headers: { cookie } }),
      app.inject({ method: "GET", url: "/api/clients?tab=one_time&pageSize=100", headers: { cookie } }),
    ]);
    const regularIds = regular.json().items.map((c: { id: string }) => c.id);
    const oneTimeIds = oneTime.json().items.map((c: { id: string }) => c.id);

    expect(regularIds.filter((id: string) => oneTimeIds.includes(id))).toHaveLength(0);
    expect(regularIds.length + oneTimeIds.length).toBe(
      regular.json().counts.regular + regular.json().counts.one_time,
    );
    // and each side matches what the DTO says about those clients
    for (const c of [...regular.json().items, ...oneTime.json().items]) {
      expect(c.isRegular).toBe(regularIds.includes(c.id));
    }
  });

  it("archives a client — gone from lists and from GET", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/clients/${individualId}/archive`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);

    const list = await app.inject({
      method: "GET",
      url: "/api/clients?tab=regular",
      headers: { cookie },
    });
    expect(list.json().items.some((c: { id: string }) => c.id === individualId)).toBe(false);

    const get = await app.inject({
      method: "GET",
      url: `/api/clients/${individualId}`,
      headers: { cookie },
    });
    expect(get.statusCode).toBe(404);
  });

  it("uploads, lists, and deletes a client file", async () => {
    const other = await prisma.client.findFirstOrThrow({ where: { archivedAt: null } });
    const boundary = "----test-boundary";
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="note.txt"',
      "Content-Type: text/plain",
      "",
      "hello client file",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const up = await app.inject({
      method: "POST",
      url: `/api/clients/${other.id}/files`,
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(up.statusCode).toBe(201);
    const file = up.json();

    const download = await app.inject({
      method: "GET",
      url: `/api/clients/${other.id}/files/${file.id}`,
      headers: { cookie },
    });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("hello client file");

    const del = await app.inject({
      method: "DELETE",
      url: `/api/clients/${other.id}/files/${file.id}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(200);
  });
  it("re-saving a client keeps the company dimension on its subscriptions and invoices", async () => {
    // companies used to be deleted+recreated on every save, so the new ids silently blanked
    // (FK SetNull) the company on subscriptions, tasks and ISSUED INVOICES
    const service = await prisma.service.create({
      data: { name: "Company FK service", color: "#2f4fd6", type: "subscription", defaultAmount: 5_000 },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: {
        firstName: "Company",
        lastName: "Dimension",
        companies: [{ name: "Alpha Ltd" }, { name: "Beta Ltd" }],
        people: [],
      },
    });
    const client = created.json();
    const alpha = client.companies.find((c: { name: string }) => c.name === "Alpha Ltd");

    await app.inject({
      method: "POST",
      url: `/api/clients/${client.id}/subscriptions`,
      headers: { cookie },
      payload: { serviceId: service.id, amount: 5_000, period: "month", companyId: alpha.id },
    });

    // an ordinary edit that re-sends the same company list
    const resaved = await app.inject({
      method: "PATCH",
      url: `/api/clients/${client.id}`,
      headers: { cookie },
      payload: { phone: "+380000000000", companies: [{ name: "Alpha Ltd" }, { name: "Beta Ltd" }] },
    });
    expect(resaved.statusCode).toBe(200);
    expect(resaved.json().companies.find((c: { name: string }) => c.name === "Alpha Ltd").id).toBe(
      alpha.id,
    );
    expect(resaved.json().subscriptions[0].companyId).toBe(alpha.id);

    const invoices = await app.inject({
      method: "GET",
      url: `/api/invoices?clientId=${client.id}`,
      headers: { cookie },
    });
    expect(invoices.json().items[0].companyName).toBe("Alpha Ltd");

    // and a company something still points at can't just be dropped
    const drop = await app.inject({
      method: "PATCH",
      url: `/api/clients/${client.id}`,
      headers: { cookie },
      payload: { companies: [{ name: "Beta Ltd" }] },
    });
    expect(drop.statusCode).toBe(409);
    expect(drop.json().error.message).toContain("Alpha Ltd");

    // an unused one still goes away
    const ok = await app.inject({
      method: "PATCH",
      url: `/api/clients/${client.id}`,
      headers: { cookie },
      payload: { companies: [{ name: "Alpha Ltd" }] },
    });
    expect(ok.json().companies.map((c: { name: string }) => c.name)).toEqual(["Alpha Ltd"]);
  });

  it("archiving a client takes their tasks off the board but leaves the invoices", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: { firstName: "Gone", lastName: "Away", companies: [], people: [] },
    });
    const client = created.json();
    const service = await prisma.service.create({
      data: { name: "Archived client job", color: "#1f8f3a", type: "one_time", defaultAmount: 1_000 },
    });
    const sub = await app.inject({
      method: "POST",
      url: `/api/clients/${client.id}/subscriptions`,
      headers: { cookie },
      payload: { serviceId: service.id, amount: 1_000, period: "month" },
    });
    await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie },
      payload: {
        title: "Work for a client about to be archived",
        clientId: client.id,
        subscriptionId: sub.json().subscriptions[0].id,
        amount: 1_000,
        assignees: [],
      },
    });

    const before = await app.inject({ method: "GET", url: "/api/tasks?view=board", headers: { cookie } });
    expect(before.json().items.some((t: { clientId: string }) => t.clientId === client.id)).toBe(true);

    await app.inject({ method: "POST", url: `/api/clients/${client.id}/archive`, headers: { cookie } });

    const after = await app.inject({ method: "GET", url: "/api/tasks?view=board", headers: { cookie } });
    expect(after.json().items.some((t: { clientId: string }) => t.clientId === client.id)).toBe(false);

    // the money stays visible — archiving a client must not hide what they owe
    const invoices = await app.inject({
      method: "GET",
      url: `/api/invoices?clientId=${client.id}`,
      headers: { cookie },
    });
    expect(invoices.json().items).toHaveLength(1);
    expect(invoices.json().items[0].clientArchived).toBe(true);
  });
});
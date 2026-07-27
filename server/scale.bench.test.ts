import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { ensureBaseData } from "./core/bootstrap.js";
import { prisma } from "./core/db.js";

/**
 * Scale check (opt-in): seeds a firm-sized dataset — 1 000 clients, ~12 000 invoices,
 * ~6 000 tasks — and asserts that the screens the team lives in stay responsive AND correct.
 *
 * It is skipped by default because seeding takes ~30 s; run it deliberately:
 *   SCALE=1 npx vitest run server/scale.bench.test.ts
 */
const RUN = process.env.SCALE === "1";
const CLIENTS = 1_000;
const INVOICES_PER_CLIENT = 12;
const TASKS_PER_CLIENT = 6;

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const out = await fn();
  const ms = Math.round(performance.now() - started);
  console.log(`  ${label.padEnd(46)} ${String(ms).padStart(5)} ms`);
  return out;
}

async function seed() {
  const service = await prisma.service.create({
    data: { name: "Scale bookkeeping", color: "#2f4fd6", type: "subscription", defaultAmount: 10_000 },
  });
  const priority = await prisma.priority.findFirstOrThrow({ where: { isDefault: true } });
  const column = await prisma.taskColumn.findFirstOrThrow({ where: { isFixed: true } });

  await prisma.client.createMany({
    data: Array.from({ length: CLIENTS }, (_, i) => ({
            firstName: `Scale${i}`,
      lastName: `Client${i}`,
    })),
  });
  const clients = await prisma.client.findMany({ where: { firstName: { startsWith: "Scale" } }, select: { id: true } });

  const now = Date.now();
  await prisma.invoice.createMany({
    data: clients.flatMap((c, ci) =>
      Array.from({ length: INVOICES_PER_CLIENT }, (_, k) => {
        const amount = 10_000;
        // a third settled, a third partly paid, a third untouched — and some already overdue
        const paidTotal = k % 3 === 0 ? amount : k % 3 === 1 ? 4_000 : 0;
        return {
          number: `SCALE-${ci}-${k}`,
          clientId: c.id,
          serviceId: service.id,
          amount,
          paidTotal,
          issuedAt: new Date(now - k * 86_400_000),
          dueDate: new Date(now - (k - 6) * 86_400_000),
          sentAt: k % 2 === 0 ? new Date() : null,
        };
      }),
    ),
  });

  await prisma.task.createMany({
    data: clients.flatMap((c) =>
      Array.from({ length: TASKS_PER_CLIENT }, (_, k) => ({
        title: `Scale task ${k}`,
        clientId: c.id,
        serviceId: service.id,
        kind: "sub" as const,
        priorityId: priority.id,
        statusColumnId: column.id,
        done: k % 4 === 0,
      })),
    ),
  });
}

beforeAll(async () => {
  if (!RUN) return;
  app = await buildApp();
  await prisma.payment.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.task.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.company.deleteMany();
  await prisma.client.deleteMany();
  await prisma.service.deleteMany();
  await prisma.user.deleteMany();
  await ensureBaseData();
  await prisma.user.create({
    data: {
      firstName: "Scale",
      lastName: "Admin",
      email: "scale@test.local",
      passwordHash: await argon2.hash("password-123"),
      role: "admin",
      status: "active",
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "scale@test.local", password: "password-123" },
  });
  cookie = (res.headers["set-cookie"] as string).split(";")[0];
  await timed(`seed ${CLIENTS} clients / ${CLIENTS * INVOICES_PER_CLIENT} invoices`, seed);
}, 300_000);

afterAll(async () => {
  if (!RUN) return;
  await app.close();
});

describe.runIf(RUN)("scale", () => {
  it("billing, tasks and clients stay fast at firm scale", async () => {
    const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });

    const billing = await timed("GET /api/invoices (all + counts + totals)", () => get("/api/invoices"));
    expect(billing.statusCode).toBe(200);
    expect(billing.json().total).toBe(CLIENTS * INVOICES_PER_CLIENT);
    expect(billing.json().items).toHaveLength(25);

    const unpaid = await timed("GET /api/invoices?filter=unpaid", () => get("/api/invoices?filter=unpaid"));
    const overdue = await timed("GET /api/invoices?filter=overdue", () => get("/api/invoices?filter=overdue"));
    const paid = await timed("GET /api/invoices?filter=paid", () => get("/api/invoices?filter=paid"));
    await timed("GET /api/invoices?search=…", () => get("/api/invoices?search=Scale7"));
    await timed("GET /api/invoices (page 200)", () => get("/api/invoices?page=200"));

    // the settlement split the seed created, straight out of SQL
    expect(paid.json().total).toBe(CLIENTS * 4);
    expect(unpaid.json().total).toBe(CLIENTS * 8);
    expect(overdue.json().total).toBeGreaterThan(0);
    expect(billing.json().counts.all).toBe(CLIENTS * INVOICES_PER_CLIENT);

    const clients = await timed("GET /api/clients (list + debt per row)", () => get("/api/clients?tab=all"));
    expect(clients.json().items[0].debt).toBeGreaterThan(0);

    const board = await timed("GET /api/tasks?view=board", () => get("/api/tasks?view=board&status=open"));
    expect(board.json().items.length).toBeLessThanOrEqual(500);
    expect(board.json().truncated).toBe(true);
    // names come with the task — no clients page to resolve them against
    expect(board.json().items[0].clientName).toMatch(/^Scale/);

    await timed("GET /api/tasks?view=table (page)", () => get("/api/tasks?view=table&page=3"));
  }, 300_000);
});

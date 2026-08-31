/**
 * Fill a LOCAL database with a realistic year of work, so scale can be measured rather than
 * guessed at. Written for the 2026-09-01 audit (`docs/scale-audit.md`) and kept so the same
 * numbers can be taken again after the next module — a performance claim nobody can re-check
 * decays into folklore.
 *
 *   npx tsx scripts/seed-scale.ts            # seed 1000 clients + a year of invoices and tasks
 *   npx tsx scripts/seed-scale.ts --clean    # remove every row it made, and nothing else
 *
 * Every seeded client's email ends `@scale.seed`, which is what --clean matches on. It refuses to
 * run against anything but a local database: this writes thousands of rows and there is no undo
 * beyond --clean.
 */
import { prisma } from "../server/core/db.js";
import { config } from "../server/core/config.js";

const TAG = "@scale.seed";
const CLIENTS = Number(process.env.SEED_CLIENTS ?? 1000);
const MONTHS = Number(process.env.SEED_MONTHS ?? 12);
const BATCH = 500;

if (!/@(localhost|127\.0\.0\.1|db)[:/]/.test(config.DATABASE_URL)) {
  console.error("refusing to seed: DATABASE_URL is not local");
  process.exit(1);
}

async function clean() {
  const where = { where: { client: { email: { endsWith: TAG } } } };
  console.log("tasks       ", (await prisma.task.deleteMany(where)).count);
  console.log("invoices    ", (await prisma.invoice.deleteMany(where)).count);
  console.log(
    "periods     ",
    (
      await prisma.subscriptionPeriod.deleteMany({
        where: { subscription: { client: { email: { endsWith: TAG } } } },
      })
    ).count,
  );
  console.log("subscriptions", (await prisma.subscription.deleteMany(where)).count);
  console.log("clients     ", (await prisma.client.deleteMany({ where: { email: { endsWith: TAG } } })).count);
}

async function seed() {
  const priority = await prisma.priority.findFirst();
  const column = await prisma.taskColumn.findFirst({ where: { isFixed: true } });
  const services = await prisma.service.findMany({ where: { type: "subscription", active: true } });
  const user = await prisma.user.findFirst();
  if (!priority || !column || !services.length || !user) {
    throw new Error("base data missing — run the app once so bootstrap seeds priorities, columns and a user");
  }

  const F = ["Olena", "Mykhailo", "Iryna", "Andrii", "Nataliia", "Serhii", "Kateryna", "Dmytro"];
  const L = ["Kovalenko", "Shevchenko", "Bondarenko", "Tkachenko", "Kravchuk", "Melnyk", "Boyko"];
  const t0 = Date.now();

  const have = await prisma.client.count({ where: { email: { endsWith: TAG } } });
  for (let s = have; s < CLIENTS; s += BATCH) {
    await prisma.client.createMany({
      data: Array.from({ length: Math.min(BATCH, CLIENTS - s) }, (_, k) => {
        const i = s + k;
        return {
          firstName: F[i % F.length],
          lastName: `${L[(i * 7) % L.length]}${i}`,
          companyName: i % 3 === 0 ? `Company ${i} LLC` : null,
          email: `c${i}${TAG}`,
          phone: `+1704${String(1000000 + i).slice(-7)}`,
        };
      }),
    });
  }

  // one subscription each, WITH a period — the sweeps read `firstDayInForce(periods)`, so a
  // subscription without one is invisible to them and the measurement would flatter itself
  const bare = await prisma.client.findMany({
    where: { email: { endsWith: TAG }, subscriptions: { none: {} } },
    select: { id: true },
  });
  for (let i = 0; i < bare.length; i += BATCH) {
    await prisma.subscription.createMany({
      data: bare.slice(i, i + BATCH).map((c, k) => ({
        clientId: c.id,
        serviceId: services[(i + k) % services.length].id,
        amount: 15000 + ((i + k) % 40) * 500,
        period: "month" as const,
      })),
    });
  }
  const subs = await prisma.subscription.findMany({
    where: { client: { email: { endsWith: TAG } } },
    select: { id: true, clientId: true, serviceId: true, amount: true },
  });
  const noPeriod = await prisma.subscription.findMany({
    where: { client: { email: { endsWith: TAG } }, periods: { none: {} } },
    select: { id: true },
  });
  const firstDay = new Date(Date.UTC(new Date().getUTCFullYear() - 1, 0, 1));
  for (let i = 0; i < noPeriod.length; i += BATCH) {
    await prisma.subscriptionPeriod.createMany({
      data: noPeriod.slice(i, i + BATCH).map((s) => ({ subscriptionId: s.id, startsOn: firstDay })),
    });
  }

  const year = new Date().getUTCFullYear() - 1;
  if ((await prisma.invoice.count({ where: { client: { email: { endsWith: TAG } } } })) === 0) {
    for (let mo = 0; mo < MONTHS; mo++) {
      const d = new Date(Date.UTC(year, mo, 5));
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      for (let i = 0; i < subs.length; i += BATCH) {
        await prisma.invoice.createMany({
          data: subs.slice(i, i + BATCH).map((s, k) => ({
            number: `SEED-${key}-${String(i + k).padStart(5, "0")}`,
            clientId: s.clientId,
            serviceId: s.serviceId,
            subscriptionId: s.id,
            periodKey: key,
            amount: s.amount,
            paidTotal: (i + k + mo) % 3 === 0 ? 0 : s.amount,
            issuedAt: d,
            dueDate: new Date(d.getTime() + 10 * 86_400_000),
            createdById: user.id,
          })),
        });
      }
    }
  }

  if ((await prisma.task.count({ where: { client: { email: { endsWith: TAG } } } })) === 0) {
    for (let mo = 0; mo < MONTHS; mo++) {
      const d = new Date(Date.UTC(year, mo, 12));
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      for (let i = 0; i < subs.length; i += BATCH) {
        await prisma.task.createMany({
          data: subs.slice(i, i + BATCH).map((s, k) => ({
            title: `Monthly filing ${key} #${i + k}`,
            clientId: s.clientId,
            serviceId: s.serviceId,
            subscriptionId: s.id,
            periodKey: key,
            kind: "free" as const,
            priorityId: priority.id,
            statusColumnId: column.id,
            done: mo < MONTHS - 2,
            completedAt: mo < MONTHS - 2 ? new Date(d.getTime() + 3 * 86_400_000) : null,
            deadline: new Date(d.getTime() + 14 * 86_400_000),
            createdById: user.id,
          })),
        });
      }
    }
  }

  console.log({
    clients: await prisma.client.count(),
    subscriptions: await prisma.subscription.count(),
    invoices: await prisma.invoice.count(),
    tasks: await prisma.task.count(),
    ms: Date.now() - t0,
  });
}

await (process.argv.includes("--clean") ? clean() : seed());
await prisma.$disconnect();

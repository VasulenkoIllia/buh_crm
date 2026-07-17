import { PrismaPg } from "@prisma/adapter-pg";
import argon2 from "argon2";
import { PrismaClient } from "../server/generated/prisma/client.js";

// Dev seed — settings defaults + fixed "New" column + a dev admin.
// Idempotent: safe to re-run.

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const PRIORITIES = [
  { name: "Low", color: "#6b7280", order: 0, isDefault: false },
  { name: "Normal", color: "#2f4fd6", order: 1, isDefault: true },
  { name: "High", color: "#b5651d", order: 2, isDefault: false },
  { name: "Urgent", color: "#c23434", order: 3, isDefault: false },
];

const SOURCES = ["Referral", "Website", "Social", "Cold", "Event", "Other"];

async function main() {
  for (const p of PRIORITIES) {
    await prisma.priority.upsert({ where: { name: p.name }, update: p, create: p });
  }

  for (const [order, name] of SOURCES.entries()) {
    await prisma.sourceOption.upsert({
      where: { name },
      update: { order },
      create: { name, order },
    });
  }

  const newColumn = await prisma.taskColumn.findFirst({ where: { isFixed: true } });
  if (!newColumn) {
    await prisma.taskColumn.create({ data: { name: "New", order: 0, isFixed: true } });
  }

  await prisma.firmProfile.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, name: "buh_crm" },
  });

  const adminEmail = "admin@buh-crm.local";
  const admin = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!admin) {
    await prisma.user.create({
      data: {
        firstName: "Admin",
        lastName: "User",
        email: adminEmail,
        passwordHash: await argon2.hash("admin1234"),
        role: "admin",
        status: "active",
        emailConfirmedAt: new Date(),
      },
    });
    console.log(`Seeded dev admin: ${adminEmail} / admin1234`);
  }

  console.log("Seed complete.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

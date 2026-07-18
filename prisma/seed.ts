import argon2 from "argon2";
import { prisma, disconnectDb } from "../server/core/db.js";
import { ensureBaseData } from "../server/core/bootstrap.js";

// Dev seed — base defaults (shared with the production bootstrap) + a convenient
// dev admin with a known weak password. NOT used in production (there the first
// admin is created from BOOTSTRAP_ADMIN_* env vars on startup). Idempotent.

async function main() {
  await ensureBaseData();

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
  .finally(() => disconnectDb());

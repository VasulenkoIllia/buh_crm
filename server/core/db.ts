import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { config, isDev } from "./config.js";

// Prisma client singleton — modules access it ONLY through their repository.
const adapter = new PrismaPg({ connectionString: config.DATABASE_URL });

export const prisma = new PrismaClient({
  adapter,
  log: isDev ? ["warn", "error"] : ["error"],
});

export async function disconnectDb() {
  await prisma.$disconnect();
}

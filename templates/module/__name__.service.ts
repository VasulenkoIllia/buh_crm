import { findAll } from "./__name__.repository.js";

// Business logic only — no Fastify types, no Prisma.
export async function list__Name__() {
  return findAll();
}

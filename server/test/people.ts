import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import { prisma } from "../core/db.js";

/**
 * **Signed-in colleagues for a suite, under a domain of its own** (`olena@<suite>.local`), so a
 * suite removes exactly its own people and nobody else's.
 */

export interface Person {
  id: string;
  email: string;
  cookie: string;
}

const PASSWORD = "password-123";

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

export async function removePeople(domain: string) {
  const where = { user: { email: { endsWith: domain } } };
  await prisma.accessOverride.deleteMany({ where });
  await prisma.session.deleteMany({ where });
  await prisma.user.deleteMany({ where: { email: { endsWith: domain } } });
}

export async function createPeople(
  app: FastifyInstance,
  domain: string,
  names: readonly string[],
  role: "admin" | "user" = "user",
): Promise<Person[]> {
  const passwordHash = await argon2.hash(PASSWORD);
  const people: Person[] = [];
  for (const name of names) {
    const user = await prisma.user.create({
      data: {
        firstName: name,
        lastName: "Tester",
        email: `${name.toLowerCase()}${domain}`,
        passwordHash,
        role,
        status: "active",
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: user.email, password: PASSWORD },
    });
    people.push({ id: user.id, email: user.email, cookie: cookieOf(res) });
  }
  return people;
}

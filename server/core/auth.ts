import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { User } from "../generated/prisma/client.js";
import { prisma } from "./db.js";
import { ForbiddenError, UnauthorizedError } from "./errors.js";

// Cookie sessions, Postgres-backed (decision 2026-07-17):
// 30-day rolling TTL — extended on activity once less than 15 days remain.

export const SESSION_COOKIE = "sid";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_EXTEND_BELOW_MS = 15 * 24 * 60 * 60 * 1000;

declare module "fastify" {
  interface FastifyRequest {
    currentUser: User | null;
  }
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

/** Cookie is Secure whenever the request is HTTPS (trustProxy honours X-Forwarded-Proto). */
function sessionCookieOptions(request: FastifyRequest) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: request.protocol === "https",
    signed: true,
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  };
}

export async function createSession(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
) {
  const sid = randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: { id: sid, userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
  });
  reply.setCookie(SESSION_COOKIE, sid, sessionCookieOptions(request));
}

export async function destroySession(request: FastifyRequest, reply: FastifyReply) {
  const sid = readSid(request);
  if (sid) {
    await prisma.session.deleteMany({ where: { id: sid } });
  }
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

export async function destroyAllUserSessions(userId: string) {
  await prisma.session.deleteMany({ where: { userId } });
}

function readSid(request: FastifyRequest): string | null {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid ? unsigned.value : null;
}

/**
 * Resolves the session user (or null). Attached to request.currentUser.
 * When `reply` is given and the session is close to expiry, extends BOTH the DB
 * expiry and the browser cookie's Max-Age (rolling TTL — keeps active users signed in).
 */
export async function resolveUser(
  request: FastifyRequest,
  reply?: FastifyReply,
): Promise<User | null> {
  const sid = readSid(request);
  if (!sid) return null;

  const session = await prisma.session.findUnique({
    where: { id: sid },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date()) return null;
  if (session.user.status !== "active") return null;

  // rolling TTL — extend server-side expiry AND refresh the cookie lifetime
  if (session.expiresAt.getTime() - Date.now() < SESSION_EXTEND_BELOW_MS) {
    await prisma.session.update({
      where: { id: sid },
      data: { expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
    });
    reply?.setCookie(SESSION_COOKIE, sid, sessionCookieOptions(request));
  }
  return session.user;
}

/** Route guard: requires a logged-in active user. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  request.currentUser = await resolveUser(request, reply);
  if (!request.currentUser) {
    throw new UnauthorizedError();
  }
}

/** Route guard: requires the admin role. */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  if (request.currentUser!.role !== "admin") {
    throw new ForbiddenError("Admin access required");
  }
}

export async function deleteExpiredSessions() {
  await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}

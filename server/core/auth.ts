import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { User } from "../generated/prisma/client.js";
import { prisma } from "./db.js";
import { record, setActivityActor } from "./activity.js";
import { personName } from "./names.js";

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
  const session = await prisma.session.create({
    /**
     * **Where this session was opened from, captured once.**
     *
     * Not for display: it is what lets "somebody signed in from an address nobody recognises" be a
     * question anybody can ask, and it is the prerequisite the security package's detection work
     * needs as much as this module does (activity-log.md §13 A1). Only as true as `TRUST_PROXY_HOPS`
     * — behind a proxy an untrusted setting records the proxy for the whole firm.
     */
    data: {
      id: sid,
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      ip: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
    },
  });
  reply.setCookie(SESSION_COOKIE, sid, sessionCookieOptions(request));

  /**
   * **Recorded here rather than on the login route, because there are two doors.**
   *
   * Signing in and accepting an invitation both end in a session, and a sign-in log that knew about
   * one of them would be worse than none — it would read as complete. This is the one place both
   * pass through.
   *
   * The actor is PINNED: `/login` and `/accept-invite` are anonymous routes, so the request has no
   * `currentUser` and the flush would otherwise attribute the firm's own sign-in to "Anonymous".
   */
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, firstName: true, lastName: true },
  });
  if (user) {
    setActivityActor({ kind: "user", userId: user.id, label: personName(user) });
    record("session.signed_in", { subjectId: session.userId, subjectLabel: personName(user) });
  }
}

export async function destroySession(request: FastifyRequest, reply: FastifyReply) {
  const sid = readSid(request);
  if (sid) {
    /**
     * Read before deleting, and read the USER with it.
     *
     * `/logout` is an anonymous route — it has to be, or a browser whose session already expired
     * could not clear its own cookie — so `request.currentUser` is never resolved here and the
     * session row is the only thing that knows whose sign-out this is. Recording it from an absent
     * `currentUser` would have silently logged nothing at all.
     */
    const session = await prisma.session.findUnique({
      where: { id: sid },
      select: { userId: true, user: { select: { firstName: true, lastName: true } } },
    });
    await prisma.session.deleteMany({ where: { id: sid } });
    // only when a session actually went: `/logout` answers `{ok:true}` to a browser with no
    // session at all, and recording that as a sign-out would be inventing an event
    if (session) {
      setActivityActor({
        kind: "user",
        userId: session.userId,
        label: personName(session.user),
      });
      record("session.signed_out", {
        subjectId: session.userId,
        subjectLabel: personName(session.user),
      });
    }
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

/**
 * There are no `requireAuth` / `requireAdmin` route guards any more.
 *
 * They were 46 admin guards across eight route files plus 105 auth guards, nothing enumerated
 * them, and a new route was PUBLIC unless its author remembered one. Every route now declares
 * what it is — `gate()`, `shared()`, `own()` or `anonymous()` — and the single `onRequest` hook in
 * `core/access.ts` resolves the session and decides. `buildApp()` refuses to start if a route
 * under `/api` declares nothing.
 *
 * `resolveUser` above is what that hook calls.
 */

export async function deleteExpiredSessions(): Promise<number> {
  const { count } = await prisma.session.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return count;
}

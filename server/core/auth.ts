import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { User } from "../generated/prisma/client.js";
import { prisma } from "./db.js";
import { record, setActivityActor } from "./activity.js";
import { clientIp } from "./client-ip.js";
import { personName } from "./names.js";

// Cookie sessions, Postgres-backed (decision 2026-07-17), bounded since 2026-09-12 by two rules
// (docs/modules/two-factor.md §8, decisions 5 and 8):
//
//   IDLE     — a week without a request and the session is gone. The expiry is moved forward at
//              most once a day, when less than six days remain: often enough that "a week without
//              use" is what actually happens, rarely enough to cost one UPDATE per session per day.
//   ABSOLUTE — thirty days from `createdAt`, however busy. A sliding session that is used every day
//              never ends — nor does a taken laptop somebody keeps using — so without this bound a
//              second factor would be asked for once and never again.

export const SESSION_COOKIE = "sid";
const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 7 * DAY_MS;
export const SESSION_MAX_AGE_MS = 30 * DAY_MS;

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

/**
 * Cookie is Secure whenever the request is HTTPS (trustProxy honours X-Forwarded-Proto). Its
 * lifetime is whatever the session has left, so the browser forgets it when the server does.
 */
function sessionCookieOptions(request: FastifyRequest, lifetimeMs: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: request.protocol === "https",
    signed: true,
    path: "/",
    maxAge: Math.max(0, Math.floor(lifetimeMs / 1000)),
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
      expiresAt: new Date(Date.now() + SESSION_IDLE_MS),
      ip: clientIp(request),
      userAgent: request.headers["user-agent"] ?? null,
    },
  });
  reply.setCookie(SESSION_COOKIE, sid, sessionCookieOptions(request, SESSION_IDLE_MS));

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
  /**
   * **The lookup cannot be allowed to fail the sign-in it is describing.**
   *
   * `record()` swallows its own failures by design, but this read is not `record()` — it is an
   * extra query the log needs, added to a function whose job is to admit somebody. Without the
   * catch, a hiccup here answers 500 to a person whose session was already created and whose
   * cookie was already set: signed in, and told they were not (audit, 2026-09-08).
   */
  const user = await prisma.user
    .findUnique({
      where: { id: userId },
      select: { id: true, firstName: true, lastName: true },
    })
    .catch((error) => {
      console.error("activity: could not name the person signing in", error);
      return null;
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
    // …and the same guard on the way out: this read is FOR the log, and a sign-out that could not
    // be recorded must still be a sign-out
    const session = await prisma.session
      .findUnique({
        where: { id: sid },
        select: { userId: true, user: { select: { firstName: true, lastName: true } } },
      })
      .catch((error) => {
        console.error("activity: could not name the person signing out", error);
        return null;
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
 *
 * Refuses a session past either bound (see the top of this file). When `reply` is given and the
 * stored expiry needs moving, moves it AND the browser cookie's Max-Age together.
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
  if (!session) return null;
  const now = Date.now();
  const expiresAt = session.expiresAt.getTime();
  const hardEnd = session.createdAt.getTime() + SESSION_MAX_AGE_MS;
  if (expiresAt <= now || hardEnd <= now) return null;
  if (session.user.status !== "active") return null;

  /**
   * Where the expiry belongs: a week from now, never past the absolute end. It is written when it
   * has fallen more than a day behind that — the once-a-day slide — or stands beyond it: a session
   * opened before 2026-09-12 carries a thirty-day expiry, and this pulls it in on its next request,
   * while the person is using it and cannot notice.
   */
  const target = Math.min(now + SESSION_IDLE_MS, hardEnd);
  if (target - expiresAt > DAY_MS || expiresAt > target) {
    await prisma.session.update({
      where: { id: sid },
      data: { expiresAt: new Date(target) },
    });
    reply?.setCookie(SESSION_COOKIE, sid, sessionCookieOptions(request, target - now));
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

/** Sessions past either bound. The absolute one only matters for rows opened before it existed. */
export async function deleteExpiredSessions(): Promise<number> {
  const now = Date.now();
  const { count } = await prisma.session.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date(now) } },
        { createdAt: { lt: new Date(now - SESSION_MAX_AGE_MS) } },
      ],
    },
  });
  return count;
}

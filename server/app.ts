import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { config, isDev, isProd } from "./core/config.js";
import { SESSION_COOKIE } from "./core/auth.js";
import { loadFirmName } from "./core/firm.js";
import { staticCacheControl } from "./core/static-cache.js";
import { errorHandler } from "./core/errors.js";
import { authModule } from "./modules/auth/index.js";
import { catalogModule } from "./modules/catalog/index.js";
import { clientsModule } from "./modules/clients/index.js";
import { leadsModule } from "./modules/leads/index.js";
import { mailoutsModule } from "./modules/mailouts/index.js";
import { meetingsModule } from "./modules/meetings/index.js";
import { notificationsModule } from "./modules/notifications/index.js";
import { paymentsModule } from "./modules/payments/index.js";
import { settingsModule } from "./modules/settings/index.js";
import { tasksModule } from "./modules/tasks/index.js";
import { usersModule } from "./modules/users/index.js";

// Build the Fastify instance: core plugins + module registration.
// Modules are Fastify plugins registered here explicitly (no autoload magic).

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Cross-origin state-changing requests are blocked. Same-origin (Origin host === the
// Host we're serving on) is always allowed — covers prod (SPA + API on one domain) and
// local prod-mode testing over http.
//
// In DEV the API also accepts any loopback origin, because the front end is a separate server on
// its own port and that port is not fixed: Vite takes the next free one when 5173 is busy — a
// second checkout, a second session — and an allowlist of two exact ports then rejects every
// write with a 403 while GETs keep working, so the screen looks fine and only buttons are dead
// (hit on 2026-08-26, and it cost a debugging round to see). Prod is unaffected: `isDev` gates
// this entirely, and there the SPA and the API share one origin anyway.
const DEV_ORIGIN_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export async function buildApp() {
  const app = Fastify({
    // behind Traefik in prod: trust X-Forwarded-* so req.ip / req.protocol are the
    // real client's (needed for per-client rate limiting + Secure-cookie detection)
    trustProxy: isProd,
    logger: {
      level: config.LOG_LEVEL,
      ...(isDev ? { transport: { target: "pino-pretty" } } : {}),
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);

  await app.register(helmet);
  await app.register(cookie, { secret: config.SESSION_SECRET });
  /**
   * The budget belongs to a SESSION, not to an address.
   *
   * Keyed by IP — the plugin's default — ten people in one office behind one NAT shared 300
   * requests a minute between them, and when that tripped it did not degrade: everyone got 429 at
   * the same moment (2026-09-01 scale audit). A page load costs 2–6 calls, so normal work sat well
   * under it, but a busy morning with refetch-on-focus did not have much room.
   *
   * The signed cookie is read, never the session row: this runs on every request, and the point is
   * to tell one browser from another, which the cookie already does without a query.
   *
   * Anonymous requests still fall back to the address, which is what keeps the tighter limit on
   * the credential routes (10/min, see auth.routes) a brute-force defence — an attacker has no
   * session to be counted by.
   */
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (request) => {
      const raw = request.cookies?.[SESSION_COOKIE];
      const unsigned = raw ? request.unsignCookie(raw) : null;
      return unsigned?.valid && unsigned.value ? `s:${unsigned.value}` : request.ip;
    },
  });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

  // CSRF (decision 2026-07-17): JSON-only API + Origin check on state-changing routes.
  app.addHook("onRequest", async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method)) return;
    // A route may opt out — today only the public mailout unsubscribe (S10), which carries no
    // session for a forged request to ride. Its unguessable token is the credential, so this check
    // can only reject a legitimate unsubscribe whose Origin is the webmail the client is reading
    // in. Opting out is declared on the route itself, next to the reasoning.
    if (
      (request.routeOptions?.config as { skipOriginCheck?: boolean } | undefined)
        ?.skipOriginCheck
    ) {
      return;
    }
    const origin = request.headers.origin;
    if (!origin) return; // no Origin header — SameSite=Lax already covers this
    const deny = () =>
      reply.status(403).send({ error: { code: "forbidden", message: "Origin not allowed" } });
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      return deny();
    }
    if (originUrl.host === request.host) return; // same-origin
    // dev: the front end is its own server on whatever port it could get
    if (isDev && DEV_ORIGIN_HOSTNAMES.has(originUrl.hostname)) return;
    return deny();
  });

  app.get("/health", async () => ({
    status: "ok",
    app: config.APP_NAME,
    timestamp: new Date().toISOString(),
  }));

  // ── Modules (registered per stage) ────────────────────────────────────────
  await app.register(authModule, { prefix: "/api/auth" }); // S1
  await app.register(usersModule, { prefix: "/api/users" }); // S1
  await app.register(settingsModule, { prefix: "/api/settings" }); // S2
  await app.register(catalogModule, { prefix: "/api/catalog" }); // S3
  await app.register(clientsModule, { prefix: "/api/clients" }); // S4 (partial — no Catalog yet)
  await app.register(leadsModule, { prefix: "/api/leads" }); // S5 (partial — no Catalog/Calendar yet)
  await app.register(tasksModule, { prefix: "/api/tasks" }); // S6
  await app.register(paymentsModule, { prefix: "/api/invoices" }); // S7
  await app.register(meetingsModule, { prefix: "/api/calendar" }); // S8
  await app.register(notificationsModule, { prefix: "/api/notifications" }); // S9
  await app.register(mailoutsModule, { prefix: "/api/mailouts" }); // S10

  // ── Serve the built SPA in production (single-container: API + web) ────────
  // Vite builds the frontend into ./dist; this app serves it and falls back to
  // index.html for client-side routes so emailed links (/set-password, /reset-password) resolve.
  if (isProd) {
    const distDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist");
    await app.register(fastifyStatic, {
      root: distDir,
      prefix: "/",
      /**
       * Screens are fetched on demand now, so how long their file may be kept decides whether a
       * person sees the loading line once or every time they open that screen.
       *
       * Vite content-hashes everything under `/assets`, so those names are IMMUTABLE by
       * construction — a change produces a different name. They were being served
       * `max-age=0`, which makes the browser revalidate on every navigation: cheap in bytes
       * (a 304) but a full network round-trip each time, which is invisible on an office LAN and
       * very visible to somebody working remotely (2026-09-01).
       *
       * `index.html` is the opposite and must never be cached: it is the map from route to hashed
       * file, so a stale one points a browser at the previous deploy's chunks.
       */
      setHeaders: (res, filePath) => {
        res.header("cache-control", staticCacheControl(filePath));
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (
        request.method === "GET" &&
        !request.url.startsWith("/api") &&
        !request.url.startsWith("/health")
      ) {
        return reply.sendFile("index.html"); // SPA client-side routing
      }
      return reply.status(404).send({ error: { code: "not_found", message: "Not Found" } });
    });
  }

  // the name letters print, read once here rather than per send — see core/firm.ts
  await loadFirmName();

  return app;
}

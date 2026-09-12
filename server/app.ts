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
import { config, isDev, isProd, isTest } from "./core/config.js";
import { SESSION_COOKIE } from "./core/auth.js";
import { loadFirmName } from "./core/firm.js";
import { staticCacheControl } from "./core/static-cache.js";
import { errorHandler } from "./core/errors.js";
import { accessHook, anonymous } from "./core/access.js";
import { actorFromUser, enterActivityContext, flushStore } from "./core/activity.js";
import { clientIp } from "./core/client-ip.js";
import { collectRouteInventory, type RouteRecord } from "./core/route-inventory.js";
import { accessModule } from "./modules/access/index.js";
import { activityModule } from "./modules/activity/index.js";
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
import { twoFactorModule } from "./modules/two-factor/index.js";
import { usersModule } from "./modules/users/index.js";

// Build the Fastify instance: core plugins + module registration.
// Modules are Fastify plugins registered here explicitly (no autoload magic).

declare module "fastify" {
  interface FastifyInstance {
    /** every route this build answers — see core/route-inventory.ts */
    routeInventory: RouteRecord[];
  }
}

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
    /**
     * Behind Traefik in prod: trust `X-Forwarded-*` so `req.ip` / `req.protocol` are the real
     * client's (needed for per-client rate limiting and Secure-cookie detection).
     *
     * A COUNT, not `true`, since 2026-09-08. `true` trusts the entire chain, so the leftmost entry
     * in `X-Forwarded-For` wins — and that entry is whatever the caller typed into the header.
     * That was harmless while the rate limiter was the only reader; it is not harmless now that
     * every sign-in and every mutation stores an address somebody may later be asked to account
     * for. `TRUST_PROXY_HOPS` defaults to the two real hops here (Cloudflare, then Traefik) and is
     * an env var because that is a deployment fact — see core/config.ts.
     *
     * It is not, on its own, enough to name the caller: Traefik replaces the `X-Forwarded-For` it
     * receives, so the caller's address never reaches this header and no hop count can find it.
     * `core/client-ip.ts` is where that is solved, and why.
     */
    trustProxy: isProd ? config.TRUST_PROXY_HOPS : false,
    logger: {
      level: config.LOG_LEVEL,
      ...(isDev ? { transport: { target: "pino-pretty" } } : {}),
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);

  /**
   * Helmet's defaults, plus the two origins Cloudflare's own analytics needs.
   *
   * The site is proxied through Cloudflare (docs/deployment.md), and when Web Analytics is on
   * there, Cloudflare INJECTS `beacon.min.js` into every page it serves. Helmet's default
   * `script-src 'self'` then refuses it, which is the console error people see: the app is
   * unharmed, the analytics simply never run.
   *
   * Named origins, not a wildcard, and only the two that beacon actually uses — the script itself
   * and the endpoint it reports to. Everything else stays at helmet's default.
   *
   * **This is a deliberate widening, and it is reversible from the other end.** A third-party
   * script on every page of a CRM holding clients' financial records is a real surface, however
   * reputable the party. Turning Web Analytics off in the Cloudflare dashboard removes the
   * injection, the console error AND the need for these two lines — and is the stricter choice if
   * the numbers are not being read (raised with the user, 2026-09-06).
   */
  const CLOUDFLARE_ANALYTICS = {
    script: "https://static.cloudflareinsights.com",
    report: "https://cloudflareinsights.com",
  };
  const defaults = helmet.contentSecurityPolicy.getDefaultDirectives();
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        ...defaults,
        "script-src": [
          ...((defaults["script-src"] as string[] | undefined) ?? ["'self'"]),
          CLOUDFLARE_ANALYTICS.script,
        ],
        "connect-src": [
          ...((defaults["connect-src"] as string[] | undefined) ?? ["'self'"]),
          CLOUDFLARE_ANALYTICS.report,
        ],
      },
    },
  });
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
    /**
     * Raised out of the way under test, exactly as the credential routes do it
     * (`auth.routes.ts`: `isTest ? 1000 : 10`). What the suite checks about this plugin is that the
     * budget belongs to a SESSION rather than an address, and it checks it by comparing
     * `x-ratelimit-remaining` between two cookies — which a higher ceiling does not affect. What a
     * 300 ceiling DOES affect is any suite that walks the whole API: the access matrix fires some
     * 900 requests through one session, and a 429 halfway through would look like an access
     * failure and be debugged as one.
     */
    max: isTest ? 100_000 : 300,
    timeWindow: "1 minute",
    keyGenerator: (request) => {
      const raw = request.cookies?.[SESSION_COOKIE];
      const unsigned = raw ? request.unsignCookie(raw) : null;
      // `clientIp`, not `request.ip`: without a session the key IS the address, and while that
      // was Cloudflare's every sign-in arriving through one edge shared a single budget
      return unsigned?.valid && unsigned.value ? `s:${unsigned.value}` : clientIp(request);
    },
  });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

  /**
   * **The activity context, opened before anything can refuse the request.**
   *
   * First of the `onRequest` hooks on purpose: the Origin check and the access hook both refuse by
   * themselves, and a refusal that happened outside a context would be the one thing the log could
   * not see — which is exactly the gap `permissions.md` §20.3 hands to this module.
   *
   * Opening a context is an object and an `enterWith`; it writes nothing. A read that no service
   * describes flushes zero rows and touches the database not at all, which is what keeps "reads are
   * not logged" (activity-log.md §3.2) true without an allow-list of routes.
   */
  app.addHook("onRequest", async (request) => {
    const declared = (
      request.routeOptions?.config as { access?: { gate?: string } } | undefined
    )?.access;
    request.activity = enterActivityContext({
      // Anonymous until the access hook resolves somebody. A service may pin it earlier — signing
      // in is the case: `createSession` knows who it just admitted, and the request that carried
      // it has no `currentUser` at all, because /login is an anonymous route.
      actor: actorFromUser(null),
      ip: clientIp(request),
      userAgent: request.headers["user-agent"] ?? null,
      gate: declared?.gate ?? null,
      method: request.method,
      /**
       * The PATTERN (`/api/clients/:id`), never the filled URL: it groups, and it keeps record ids
       * out of a column that is read by a screen.
       *
       * An UNMATCHED request has no pattern, and the fallback used to be `request.url` — which is
       * the filled one, query string and all. Fastify copies instance-level hooks into its 404
       * context, so this pair really does run for a mistyped path, and a typo in
       * `POST /api/clients/<uuid>/secrets/reveal?token=…` wrote the uuid AND the token into the two
       * columns the screen prints (audit, 2026-09-09). There is no route to name, so it says so.
       */
      route: request.routeOptions?.url ?? "(no route)",
    });
  });

  /**
   * **And flushed once the outcome is known.**
   *
   * `onResponse` runs after the reply is written — so after the handler's transaction committed,
   * which is the rule this module cannot get wrong because it is not a rule here but a
   * construction (core/activity.ts). It is also the first moment `outcome` exists: at `onRequest` a
   * gate refusal, a validation error and a success are indistinguishable.
   */
  app.addHook("onResponse", async (request, reply) => {
    const store = request.activity;
    if (!store) return;
    // Only when there IS one: an anonymous request keeps whatever the store holds, which is
    // "Anonymous" unless a service knew better (see the seed above).
    if (request.currentUser) store.actor = actorFromUser(request.currentUser);
    const status = reply.statusCode;
    await flushStore(store, {
      outcome: status < 400 ? "ok" : status === 401 || status === 403 ? "refused" : "failed",
      /**
       * Every mutation, automatically — and only mutations. A kanban board polling every minute is
       * not an act, and a log of it answers nothing (§3.2).
       *
       * **Plus every 403, whatever the method.** A gate refusal is recorded as
       * `session.gate_refused` because the permissions module keeps no record of what it decided —
       * and the overwhelming majority of refusals are somebody OPENING a screen, which is a `GET`.
       * Gating the whole tier-1 block on the method meant "a lead was refused Billing" was the one
       * shape never written, while a refused `PATCH` was (audit, 2026-09-09). 403 and not `refused`,
       * which also covers 401: being unauthenticated is nobody having asked yet, and a signed-out
       * browser's stray poll does not belong in that list.
       */
      tier1: MUTATING_METHODS.has(request.method) || status === 403,
      statusCode: status,
    });
  });

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

  /**
   * **The inventory collector, and the one hook that decides access.**
   *
   * Both sit here, at the root, before a single module is registered — `onRoute` fires only for
   * routes added after it in the same context, and an access hook per module could never be "the
   * whole truth" the way one at the root is. The collector doubles as the guard against a route
   * that declares nothing: it throws, so the server does not start.
   *
   * `onRequest` rather than `preHandler` is deliberate. It runs BEFORE body parsing, so somebody
   * whose gate is closed is refused before a 25 MB multipart upload is read off the wire.
   */
  const routes = collectRouteInventory(app);
  app.decorate("routeInventory", routes);
  app.addHook("onRequest", accessHook);

  app.get("/health", { config: anonymous() }, async () => ({
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
  await app.register(accessModule, { prefix: "/api/access" }); // S14 — who may open what
  await app.register(activityModule, { prefix: "/api/activity" }); // S15 — who did what
  await app.register(twoFactorModule, { prefix: "/api/two-factor" }); // S16 — the second factor

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

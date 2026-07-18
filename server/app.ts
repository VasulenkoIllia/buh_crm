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
import { errorHandler } from "./core/errors.js";
import { authModule } from "./modules/auth/index.js";
import { clientsModule } from "./modules/clients/index.js";
import { leadsModule } from "./modules/leads/index.js";
import { settingsModule } from "./modules/settings/index.js";
import { usersModule } from "./modules/users/index.js";

// Build the Fastify instance: core plugins + module registration.
// Modules are Fastify plugins registered here explicitly (no autoload magic).

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Cross-origin state-changing requests are blocked. Same-origin (Origin host === the
// Host we're serving on) is always allowed — covers prod (SPA + API on one domain) and
// local prod-mode testing over http. Dev additionally allows the Vite dev server (:5173).
const DEV_ORIGINS = new Set(["http://localhost:5173", "http://localhost:3000"]);

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
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

  // CSRF (decision 2026-07-17): JSON-only API + Origin check on state-changing routes.
  app.addHook("onRequest", async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    if (!origin) return; // no Origin header — SameSite=Lax already covers this
    const deny = () =>
      reply.status(403).send({ error: { code: "forbidden", message: "Origin not allowed" } });
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return deny();
    }
    if (originHost === request.host) return; // same-origin
    if (isDev && DEV_ORIGINS.has(origin)) return; // Vite dev server → API
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
  await app.register(clientsModule, { prefix: "/api/clients" }); // S4 (partial — no Catalog yet)
  await app.register(leadsModule, { prefix: "/api/leads" }); // S5 (partial — no Catalog/Calendar yet)

  // ── Serve the built SPA in production (single-container: API + web) ────────
  // Vite builds the frontend into ./dist; this app serves it and falls back to
  // index.html for client-side routes so emailed links (/set-password, /reset-password) resolve.
  if (isProd) {
    const distDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist");
    await app.register(fastifyStatic, { root: distDir, prefix: "/" });
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

  return app;
}

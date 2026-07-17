import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { config, isDev } from "./core/config.js";
import { errorHandler } from "./core/errors.js";
import { authModule } from "./modules/auth/index.js";
import { usersModule } from "./modules/users/index.js";

// Build the Fastify instance: core plugins + module registration.
// Modules are Fastify plugins registered here explicitly (no autoload magic).

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function allowedOrigins(): Set<string> {
  const origins = new Set<string>();
  if (isDev) {
    origins.add("http://localhost:5173");
    origins.add(`http://localhost:${config.PORT}`);
  }
  origins.add(`https://${config.APP_DOMAIN}`);
  return origins;
}

export async function buildApp() {
  const app = Fastify({
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
  const origins = allowedOrigins();
  app.addHook("onRequest", async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    if (origin && !origins.has(origin)) {
      return reply
        .status(403)
        .send({ error: { code: "forbidden", message: "Origin not allowed" } });
    }
  });

  app.get("/health", async () => ({
    status: "ok",
    app: config.APP_NAME,
    timestamp: new Date().toISOString(),
  }));

  // ── Modules (registered per stage) ────────────────────────────────────────
  await app.register(authModule, { prefix: "/api/auth" }); // S1
  await app.register(usersModule, { prefix: "/api/users" }); // S1
  // await app.register(settingsModule, { prefix: "/api/settings" }); // S2

  return app;
}

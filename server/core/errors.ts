import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { plural } from "@shared/text.js";
import { setActivityRefusal } from "./activity.js";

// Consistent error shape across the whole API:
// { error: { code, message, details? } }

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, "not_found", message);
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed", details?: unknown) {
    super(400, "validation_error", message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(401, "unauthorized", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(403, "forbidden", message);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict", details?: unknown) {
    super(409, "conflict", message, details);
  }
}

/**
 * Too many wrong passwords or codes in a row (two-factor.md §9). Carries how long to wait, which the
 * handler sends as `Retry-After` — a refusal, never a pause: a server that sleeps on an attempt
 * holds a connection for it, and an attacker simply opens more of them.
 */
export class TooManyAttemptsError extends AppError {
  constructor(public readonly retryAfterSeconds: number) {
    super(
      429,
      "too_many_attempts",
      `Too many attempts. Try again in ${plural(retryAfterSeconds, "second")}.`,
    );
  }
}

export function errorHandler(
  error: FastifyError | AppError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof AppError) {
    /**
     * **The name of the refusal, kept for the log.**
     *
     * `module_closed`, `admin_only` and `forbidden` mean three different things to the person who
     * met them, and until now this function returned without recording any of them — the
     * permissions module decided and kept no runtime record of what it decided
     * (`permissions.md` §20.3). The status code alone cannot tell them apart, so the code is
     * stashed on the request's activity store and the flush writes it beside the outcome.
     */
    if (error.statusCode === 401 || error.statusCode === 403) {
      setActivityRefusal(error.code, request.activity);
    }
    if (error instanceof TooManyAttemptsError) {
      reply.header("Retry-After", String(error.retryAfterSeconds));
    }
    return reply.status(error.statusCode).send({
      error: { code: error.code, message: error.message, details: error.details },
    });
  }

  // Fastify/Zod validation errors
  if ("validation" in error && error.validation) {
    return reply.status(400).send({
      error: { code: "validation_error", message: error.message, details: error.validation },
    });
  }

  // Prisma known request errors → meaningful statuses (unique/FK races would otherwise be 500s)
  const prismaCode = (error as { code?: unknown }).code;
  if (typeof prismaCode === "string" && /^P2\d{3}$/.test(prismaCode)) {
    if (prismaCode === "P2002") {
      return reply.status(409).send({
        error: { code: "conflict", message: "A record with this value already exists" },
      });
    }
    if (prismaCode === "P2025") {
      return reply.status(404).send({
        error: { code: "not_found", message: "Record not found" },
      });
    }
    if (prismaCode === "P2003") {
      return reply.status(400).send({
        error: { code: "validation_error", message: "Related record does not exist" },
      });
    }
  }

  if (error.statusCode && error.statusCode < 500) {
    return reply.status(error.statusCode).send({
      error: { code: error.code ?? "bad_request", message: error.message },
    });
  }

  request.log.error({ err: error }, "unhandled error");
  return reply.status(500).send({
    error: { code: "internal_error", message: "Internal server error" },
  });
}

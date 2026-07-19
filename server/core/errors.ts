import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

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

export function errorHandler(
  error: FastifyError | AppError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof AppError) {
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

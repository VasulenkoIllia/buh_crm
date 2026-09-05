import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { inviteUserInput, updateProfileInput, updateUserInput } from "@shared/schema/user.js";
import { uuid } from "@shared/schema/common.js";
import { createSession } from "../../core/auth.js";
import { gate, own, shared } from "../../core/access.js";
import { ValidationError } from "../../core/errors.js";
import { readFileStream } from "../../core/files.js";
import { toPublicUser } from "../auth/index.js";
import * as service from "./users.service.js";

const idParams = z.object({ id: uuid });

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  // ── Team (admin) ──────────────────────────────────────────────────────────

  app.get("/", { config: gate("team") }, async () => {
    const users = await service.listUsers();
    return users.map(toPublicUser);
  });

  app.post(
    "/invites",
    { config: gate("team"), schema: { body: inviteUserInput } },
    async (request, reply) => {
      const user = await service.inviteUser(request.body, request.currentUser!);
      return reply.status(201).send(toPublicUser(user));
    },
  );

  app.post(
    "/:id/resend-invite",
    { config: gate("team"), schema: { params: idParams } },
    async (request) => {
      const user = await service.resendInvite(request.params.id, request.currentUser!);
      return toPublicUser(user);
    },
  );

  app.patch(
    "/:id",
    { config: gate("team"), schema: { params: idParams, body: updateUserInput } },
    async (request) => {
      const user = await service.updateUser(
        request.params.id,
        request.body,
        request.currentUser!,
      );
      return toPublicUser(user);
    },
  );

  // ── Profile (self) ────────────────────────────────────────────────────────

  app.patch(
    "/me",
    { config: own(), schema: { body: updateProfileInput } },
    async (request, reply) => {
      const user = await service.updateProfile(request.currentUser!, request.body);
      if (request.body.newPassword) {
        // the password change destroyed all sessions — re-issue one for this device
        await createSession(request, reply, user.id);
      }
      return toPublicUser(user);
    },
  );

  app.put("/me/avatar", { config: own() }, async (request) => {
    const part = await request.file();
    if (!part) throw new ValidationError("Avatar file is required");
    const buffer = await part.toBuffer();
    const user = await service.setAvatar(request.currentUser!, {
      buffer,
      filename: part.filename,
      mimetype: part.mimetype,
    });
    return toPublicUser(user);
  });

  // avatar bytes — auth required, streamed from the uploads volume
  app.get(
    "/:id/avatar",
    { config: shared(), schema: { params: idParams } },
    async (request, reply) => {
      const file = await service.getAvatarFile(request.params.id);
      reply.header("Content-Type", file.mime);
      reply.header("Cache-Control", "private, max-age=300");
      return reply.send(readFileStream(file.path));
    },
  );
}

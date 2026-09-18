import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { gate } from "../../core/access.js";
import type { StreamRouteConfig } from "../../core/route-inventory.js";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import {
  addMembersInput,
  chatPingInput,
  chatSettingsInput,
  createGroupInput,
  openDirectInput,
  setMemberRoleInput,
  transferOwnerInput,
  updateGroupInput,
  type ChatPingResult,
  type ChatPresence,
} from "@shared/schema/chat.js";
import { publish, realtimeListening } from "../../core/realtime.js";
import * as service from "./chat.service.js";
import { onlinePeople, openStream } from "./chat.stream.js";

const idParams = z.object({ id: uuid });
const memberParams = z.object({ id: uuid, userId: uuid });

const STREAM: StreamRouteConfig = { stream: true };

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /**
   * The live connection (chat.md §7.1). `stream: true` tells every suite that walks the route
   * inventory that this response does not end (`core/route-inventory.ts`).
   *
   * No `HEAD`: Fastify adds one to every `GET`, and a `HEAD` of a stream means nothing.
   */
  app.get(
    "/stream",
    {
      exposeHeadRoute: false,
      config: { ...gate("chat"), ...STREAM },
    },
    async (request, reply) => openStream(request, reply, instance),
  );

  /**
   * **The delivery test** (Settings → System, "Live connection"): a `pong` to the caller alone,
   * through the same `NOTIFY` every chat event takes, so the tab can time the whole round trip. It
   * changes nothing, which is why it is a quiet route (`server/test/quiet-routes.ts`).
   */
  app.post(
    "/stream/ping",
    { config: gate("chat"), schema: { body: chatPingInput } },
    async (request): Promise<ChatPingResult> => {
      await publish([request.currentUser!.id], "pong", { pingId: request.body.pingId });
      return { listening: realtimeListening() };
    },
  );

  /**
   * Who has a CRM tab open right now (chat.md §5.4): every colleague sees it. The tab reads it once,
   * and then keeps it current from the stream's `presence` events.
   */
  app.get("/presence", { config: gate("chat") }, async (): Promise<ChatPresence> => ({
    online: onlinePeople(),
  }));

  // ── chats (chat.md §4) ───────────────────────────────────────────────────────
  //
  // Everything below answers only to a member of the chat it names (§4.4): the service asks, and a
  // non-member, a firm admin included, is told the chat does not exist.

  const chat = gate("chat");

  app.get("/chats", { config: chat }, async (request) =>
    service.listChats(request.currentUser!),
  );

  app.get("/chats/:id", { config: chat, schema: { params: idParams } }, async (request) =>
    service.getChat(request.currentUser!, request.params.id),
  );

  /** The active team, with when each was last online: whom a chat can be started with. */
  app.get("/people", { config: chat }, async () => service.people());

  /** The direct chat with a colleague, made the first time; a quiet route (quiet-routes.ts). */
  app.post("/direct", { config: chat, schema: { body: openDirectInput } }, async (request) =>
    service.openDirect(request.currentUser!, request.body.userId),
  );

  /** The reader's own Saved messages, made the first time; a quiet route. */
  app.post("/saved", { config: chat }, async (request) =>
    service.openSaved(request.currentUser!),
  );

  app.post("/groups", { config: chat, schema: { body: createGroupInput } }, async (request) =>
    service.createGroup(request.currentUser!, request.body),
  );

  app.patch(
    "/chats/:id",
    { config: chat, schema: { params: idParams, body: updateGroupInput } },
    async (request) =>
      service.updateGroup(request.currentUser!, request.params.id, request.body),
  );

  app.post(
    "/chats/:id/members",
    { config: chat, schema: { params: idParams, body: addMembersInput } },
    async (request) =>
      service.addMembers(request.currentUser!, request.params.id, request.body),
  );

  app.delete(
    "/chats/:id/members/:userId",
    { config: chat, schema: { params: memberParams } },
    async (request) =>
      service.removeMember(request.currentUser!, request.params.id, request.params.userId),
  );

  app.put(
    "/chats/:id/members/:userId/role",
    { config: chat, schema: { params: memberParams, body: setMemberRoleInput } },
    async (request) =>
      service.setMemberRole(
        request.currentUser!,
        request.params.id,
        request.params.userId,
        request.body,
      ),
  );

  app.post(
    "/chats/:id/owner",
    { config: chat, schema: { params: idParams, body: transferOwnerInput } },
    async (request) =>
      service.transferOwner(request.currentUser!, request.params.id, request.body.userId),
  );

  app.post(
    "/chats/:id/leave",
    { config: chat, schema: { params: idParams } },
    async (request) => {
      await service.leave(request.currentUser!, request.params.id);
      return { ok: true };
    },
  );

  /** Mute, pin, hide: the reader's own list; a quiet route. */
  app.put(
    "/chats/:id/settings",
    { config: chat, schema: { params: idParams, body: chatSettingsInput } },
    async (request) =>
      service.updateSettings(request.currentUser!, request.params.id, request.body),
  );
}

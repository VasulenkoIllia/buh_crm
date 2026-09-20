import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { gate } from "../../core/access.js";
import type { SilentRouteConfig, StreamRouteConfig } from "../../core/route-inventory.js";
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
import {
  editMessageInput,
  forwardInput,
  historyQuery,
  markReadInput,
  reactInput,
  sendMessageInput,
  voteInput,
} from "@shared/schema/chat.js";
import { isTest } from "../../core/config.js";
import { publish, realtimeListening } from "../../core/realtime.js";
import * as messages from "./chat.messages.js";
import * as service from "./chat.service.js";
import { onlinePeople, openStream } from "./chat.stream.js";

const idParams = z.object({ id: uuid });
const memberParams = z.object({ id: uuid, userId: uuid });
const messageParams = z.object({ messageId: uuid });
const pinInput = z.object({ pinned: z.boolean() });

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

  // ── messages (chat.md §5) ────────────────────────────────────────────────────
  //
  // Every one of these is a member's, and none of them describes itself in the activity log: a
  // conversation is its own record (§12.1), so they are quiet routes and keep their tier-1 rows.
  // The exception is a delete, which destroys the text and is the one act the log must hold.

  /** Sends are bounded per session, as §7.3 sets out. */
  const sending = { rateLimit: { max: isTest ? 10_000 : 60, timeWindow: "1 minute" } };

  app.get(
    "/chats/:id/messages",
    { config: chat, schema: { params: idParams, querystring: historyQuery } },
    async (request) => messages.history(request.currentUser!, request.params.id, request.query),
  );

  app.get("/chats/:id/pins", { config: chat, schema: { params: idParams } }, async (request) =>
    messages.pinned(request.currentUser!, request.params.id),
  );

  app.post(
    "/chats/:id/messages",
    { config: { ...chat, ...sending }, schema: { params: idParams, body: sendMessageInput } },
    async (request) => messages.send(request.currentUser!, request.params.id, request.body),
  );

  app.patch(
    "/messages/:messageId",
    { config: chat, schema: { params: messageParams, body: editMessageInput } },
    async (request) =>
      messages.edit(request.currentUser!, request.params.messageId, request.body),
  );

  app.delete(
    "/messages/:messageId",
    { config: chat, schema: { params: messageParams } },
    async (request) => messages.remove(request.currentUser!, request.params.messageId),
  );

  app.post(
    "/forward",
    { config: { ...chat, ...sending }, schema: { body: forwardInput } },
    async (request) => {
      await messages.forward(request.currentUser!, request.body);
      return { ok: true };
    },
  );

  /** One of each emoji per person: sending the same one again takes it back. */
  app.put(
    "/messages/:messageId/reaction",
    { config: chat, schema: { params: messageParams, body: reactInput } },
    async (request) =>
      messages.react(request.currentUser!, request.params.messageId, request.body.emoji),
  );

  app.put(
    "/messages/:messageId/pin",
    { config: chat, schema: { params: messageParams, body: pinInput } },
    async (request) =>
      messages.setPinned(request.currentUser!, request.params.messageId, request.body.pinned),
  );

  app.put(
    "/messages/:messageId/vote",
    { config: chat, schema: { params: messageParams, body: voteInput } },
    async (request) =>
      messages.vote(request.currentUser!, request.params.messageId, request.body),
  );

  app.post(
    "/messages/:messageId/poll/close",
    { config: chat, schema: { params: messageParams } },
    async (request) => messages.closePoll(request.currentUser!, request.params.messageId),
  );

  // ── read markers and typing (chat.md §5.4, §12.2) ────────────────────────────
  //
  // **The two routes that write no activity row at all.** They change nothing a person would ever
  // look up, and at a ping every three seconds while somebody types they would be most of the
  // table. Declared in the open with `activity: "none"`, listed with their reason in
  // `server/test/silent-routes.ts`, and held to that list by `activity.coverage.test.ts`.
  const silent: SilentRouteConfig = { activity: "none" };

  app.post(
    "/chats/:id/read",
    {
      config: {
        ...chat,
        ...silent,
        rateLimit: { max: isTest ? 10_000 : 60, timeWindow: "1 minute" },
      },
      schema: { params: idParams, body: markReadInput },
    },
    async (request) =>
      messages.markRead(request.currentUser!, request.params.id, request.body.seq),
  );

  app.post(
    "/chats/:id/typing",
    {
      config: {
        ...chat,
        ...silent,
        rateLimit: { max: isTest ? 10_000 : 30, timeWindow: "1 minute" },
      },
      schema: { params: idParams },
    },
    async (request) => {
      await messages.typing(request.currentUser!, request.params.id);
      return { ok: true };
    },
  );

  app.get(
    "/messages/:messageId/read-by",
    { config: chat, schema: { params: messageParams } },
    async (request) => messages.readBy(request.currentUser!, request.params.messageId),
  );
}

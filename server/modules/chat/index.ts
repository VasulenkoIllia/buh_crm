import type { FastifyInstance } from "fastify";
import { onRealtime, releaseRealtime, retainRealtime } from "../../core/realtime.js";
import { registerRoutes } from "./chat.routes.js";
import { closeAllStreams, deliverToStreams, useStreamLogger } from "./chat.stream.js";

export async function chatModule(app: FastifyInstance) {
  await registerRoutes(app);

  // every notification, from whichever process published it, goes to the streams this one holds
  onRealtime(deliverToStreams);
  useStreamLogger(app.log);
  let listening = false;
  app.addHook("onReady", async () => {
    await retainRealtime(app.log);
    listening = true;
  });
  // `app.close()` waits for every open connection, and a stream never finishes by itself
  app.addHook("preClose", async () => closeAllStreams(app));
  app.addHook("onClose", async () => {
    if (listening) await releaseRealtime();
  });
}

// the announcements channel, made and matched to the team on every boot (server.ts)
export { ensureAnnouncementsChannel } from "./chat.bootstrap.js";

// the nightly sweep: files uploaded into a chat whose message was never sent (chat.md §6.1), and
// the net under a delete that did not finish disposing of its own files (§6.3)
export {
  sweep as sweepChatFiles,
  sweepUnsentUploads as sweepUnsentChatUploads,
} from "./chat.files.js";

// a block takes a person out of every group in its own transaction; an unblock brings the channel
// back (chat.md §11, users.service)
export { announceBlock, joinChannel, leaveChatsOnBlock } from "./chat.service.js";

import { z } from "zod";
import { uuid } from "./common.js";

/**
 * The chat: what crosses the wire (docs/modules/chat.md). The live connection's events are
 * `shared/realtime.ts`.
 *
 * The browser imports these TYPE-ONLY, except a form that validates with one: a value import drags
 * the zod runtime into whichever chunk takes it (docs/architecture.md §5).
 */

/** Who has a CRM tab open right now (chat.md §5.4). Changes arrive as `presence` events. */
export const chatPresenceSchema = z.object({
  online: z.array(uuid),
});
export type ChatPresence = z.infer<typeof chatPresenceSchema>;

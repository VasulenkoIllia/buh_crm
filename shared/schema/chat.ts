import { z } from "zod";
import { uuid } from "./common.js";
import { userStatus } from "./enums.js";

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

/**
 * The delivery test on Settings → System (chat.md §15.1, step 0.4): the tab names a ping, the server
 * publishes a `pong` with it to the caller alone, and the tab measures the round trip.
 */
export const chatPingInput = z.object({ pingId: uuid });
export type ChatPingInput = z.infer<typeof chatPingInput>;

export const chatPingResultSchema = z.object({
  /** whether this server is listening to the database right now; without it no event arrives */
  listening: z.boolean(),
});
export type ChatPingResult = z.infer<typeof chatPingResultSchema>;

// ── chats (chat.md §4) ─────────────────────────────────────────────────────────

export const chatKind = z.enum(["direct", "group", "saved", "announcements"]);
export type ChatKind = z.infer<typeof chatKind>;

export const chatMemberRole = z.enum(["owner", "admin", "member"]);
export type ChatMemberRole = z.infer<typeof chatMemberRole>;

/** A colleague as the chat shows them: enough for a name, an avatar and "blocked". */
export const chatPersonSchema = z.object({
  id: uuid,
  firstName: z.string(),
  lastName: z.string(),
  avatarFileId: uuid.nullable(),
  status: userStatus,
});
export type ChatPerson = z.infer<typeof chatPersonSchema>;

/** The people one may write to, with when each was last online (§5.4). */
export const chatPeopleSchema = z.array(
  chatPersonSchema.extend({ lastSeenAt: z.iso.datetime().nullable() }),
);
export type ChatPeople = z.infer<typeof chatPeopleSchema>;

/**
 * One row of the chat list (§4.2). A direct chat is named by `peer`, a group by `title`; Saved
 * messages and the channel are named by the screen from `kind`.
 */
export const chatSummarySchema = z.object({
  id: uuid,
  kind: chatKind,
  title: z.string().nullable(),
  peer: chatPersonSchema.nullable(),
  myRole: chatMemberRole,
  memberCount: z.number().int(),
  lastSeq: z.number().int(),
  lastReadSeq: z.number().int(),
  unread: z.number().int(),
  /** somebody mentioned the reader in a message they have not read yet */
  mentioned: z.boolean(),
  mutedUntil: z.iso.datetime().nullable(),
  pinnedAt: z.iso.datetime().nullable(),
  lastActivityAt: z.iso.datetime(),
});
export type ChatSummary = z.infer<typeof chatSummarySchema>;

export const chatMemberSchema = chatPersonSchema.extend({
  role: chatMemberRole,
  joinedAt: z.iso.datetime(),
});
export type ChatMember = z.infer<typeof chatMemberSchema>;

/** One chat with its people: its panel (§17). */
export const chatDetailSchema = chatSummarySchema.extend({
  description: z.string().nullable(),
  members: z.array(chatMemberSchema),
});
export type ChatDetail = z.infer<typeof chatDetailSchema>;

const groupTitle = z.string().trim().min(1).max(100);
const groupDescription = z.string().trim().max(500);

export const createGroupInput = z.object({
  title: groupTitle,
  description: groupDescription.optional(),
  /** the others; the creator is in it as its owner */
  memberIds: z.array(uuid).min(1).max(200),
});
export type CreateGroupInput = z.infer<typeof createGroupInput>;

export const updateGroupInput = z
  .object({ title: groupTitle.optional(), description: groupDescription.nullable().optional() })
  .refine((v) => v.title !== undefined || v.description !== undefined, "Nothing to change");
export type UpdateGroupInput = z.infer<typeof updateGroupInput>;

export const addMembersInput = z.object({ userIds: z.array(uuid).min(1).max(200) });
export type AddMembersInput = z.infer<typeof addMembersInput>;

export const setMemberRoleInput = z.object({ role: z.enum(["admin", "member"]) });
export type SetMemberRoleInput = z.infer<typeof setMemberRoleInput>;

export const transferOwnerInput = z.object({ userId: uuid });
export type TransferOwnerInput = z.infer<typeof transferOwnerInput>;

export const openDirectInput = z.object({ userId: uuid });
export type OpenDirectInput = z.infer<typeof openDirectInput>;

export const muteFor = z.enum(["off", "hour", "eight_hours", "day", "forever"]);
export type MuteFor = z.infer<typeof muteFor>;

/** The reader's own list: none of it changes the chat for anybody else. */
export const chatSettingsInput = z
  .object({
    mute: muteFor.optional(),
    pinned: z.boolean().optional(),
    hidden: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to change");
export type ChatSettingsInput = z.infer<typeof chatSettingsInput>;

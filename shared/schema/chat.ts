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
  /** how far the others have read: ✓✓ on everything up to it (§5.4) */
  othersReadSeq: z.number().int(),
  mutedUntil: z.iso.datetime().nullable(),
  pinnedAt: z.iso.datetime().nullable(),
  lastActivityAt: z.iso.datetime(),
});
export type ChatSummary = z.infer<typeof chatSummarySchema>;

export const chatMemberSchema = chatPersonSchema.extend({
  role: chatMemberRole,
  joinedAt: z.iso.datetime(),
  /** how far this person has read, and when their marker last moved */
  readSeq: z.number().int(),
  lastReadAt: z.iso.datetime().nullable(),
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

// ── messages (chat.md §5) ──────────────────────────────────────────────────────

export const chatMessageKind = z.enum(["text", "poll", "notice"]);
export type ChatMessageKind = z.infer<typeof chatMessageKind>;

export const chatNotice = z.enum([
  "created",
  "renamed",
  "member_added",
  "member_removed",
  "member_left",
  "member_blocked",
  "role_changed",
  "owner_changed",
]);
export type ChatNotice = z.infer<typeof chatNotice>;

/** What a reply quotes: enough for one line, and where to scroll to (§5.2). */
export const chatReplySchema = z.object({
  id: uuid,
  seq: z.number().int(),
  authorId: uuid.nullable(),
  /** the first line of the original, or null once it is deleted */
  preview: z.string().nullable(),
  deleted: z.boolean(),
});

export const chatReactionSchema = z.object({ emoji: z.string(), userIds: z.array(uuid) });

export const chatPollSchema = z.object({
  multiple: z.boolean(),
  options: z.array(z.string()),
  closedAt: z.iso.datetime().nullable(),
  /** never anonymous (§5.5): everybody in the chat sees who chose what */
  votes: z.array(z.object({ option: z.number().int(), userIds: z.array(uuid) })),
});

export const chatMessageSchema = z.object({
  id: uuid,
  seq: z.number().int(),
  kind: chatMessageKind,
  authorId: uuid.nullable(),
  /** null for a notice, and once a message is deleted for everyone */
  text: z.string().nullable(),
  /** a line the chat wrote itself: a code and the people it is about */
  notice: z.object({ code: chatNotice, userIds: z.array(uuid) }).nullable(),
  replyTo: chatReplySchema.nullable(),
  /** "Forwarded from": the original author */
  forwardedFromId: uuid.nullable(),
  mentions: z.array(uuid),
  reactions: z.array(chatReactionSchema),
  poll: chatPollSchema.nullable(),
  pinned: z.boolean(),
  editedAt: z.iso.datetime().nullable(),
  deletedAt: z.iso.datetime().nullable(),
  /** who deleted it, when that was an admin rather than its author */
  deletedByOther: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/** A page of history, oldest first, with the people it names (some may have left the chat). */
export const chatMessagePageSchema = z.object({
  messages: z.array(chatMessageSchema),
  people: z.array(chatPersonSchema),
  /** there is more above this page */
  more: z.boolean(),
});
export type ChatMessagePage = z.infer<typeof chatMessagePageSchema>;

export const MESSAGE_LIMIT = 4_000;
export const POLL_OPTION_LIMIT = 100;

export const newPollInput = z.object({
  options: z.array(z.string().trim().min(1).max(POLL_OPTION_LIMIT)).min(2).max(10),
  multiple: z.boolean().default(false),
});

export const sendMessageInput = z
  .object({
    /** the author's own id for this send, so a retry after a lost connection posts once (§5.1) */
    clientMessageId: uuid,
    text: z.string().max(MESSAGE_LIMIT).optional(),
    replyToId: uuid.optional(),
    /** the people named in the text; `@all` is expanded by the composer */
    mentions: z.array(uuid).max(200).optional(),
    poll: newPollInput.optional(),
  })
  .refine((v) => (v.text?.trim() ?? "") !== "" || v.poll, "A message needs something in it")
  .refine((v) => !(v.poll && v.replyToId), "A poll cannot be a reply");
export type SendMessageInput = z.infer<typeof sendMessageInput>;

export const editMessageInput = z.object({ text: z.string().trim().min(1).max(MESSAGE_LIMIT) });
export type EditMessageInput = z.infer<typeof editMessageInput>;

export const forwardInput = z.object({
  messageIds: z.array(uuid).min(1).max(20),
  /** where they go: chats the sender is in */
  toChatIds: z.array(uuid).min(1).max(10),
});
export type ForwardInput = z.infer<typeof forwardInput>;

export const reactInput = z.object({ emoji: z.string().trim().min(1).max(32) });
export type ReactInput = z.infer<typeof reactInput>;

export const voteInput = z.object({ options: z.array(z.number().int().min(0).max(9)).max(10) });
export type VoteInput = z.infer<typeof voteInput>;

export const historyQuery = z.object({
  /** the page ends below this place; without it, the newest page */
  before: z.coerce.number().int().positive().optional(),
  /** everything after this place, for a tab catching up (§7.1) */
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type HistoryQuery = z.infer<typeof historyQuery>;

/** Who has read a message, and when they last read in that chat (§5.4). */
export const readBySchema = z.object({
  people: z.array(chatPersonSchema.extend({ at: z.iso.datetime().nullable() })),
});
export type ReadBy = z.infer<typeof readBySchema>;

export const markReadInput = z.object({ seq: z.number().int().min(0) });
export type MarkReadInput = z.infer<typeof markReadInput>;

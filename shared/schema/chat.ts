import { z } from "zod";
import { uuid } from "./common.js";
import { userStatus } from "./enums.js";
import { placeInput } from "./files.js";

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
/** The one line a chat's row shows (§4.2), and when it was said. */
export const chatLastMessageSchema = z.object({
  seq: z.number().int(),
  authorId: uuid.nullable(),
  kind: z.enum(["text", "poll", "notice"]),
  notice: z.string().nullable(),
  /** the first line, or null for a deleted message and for a notice */
  preview: z.string().nullable(),
  /** how many files it carried, so a photo sent with no words is not an empty line (§4.2) */
  files: z.number().int(),
  deleted: z.boolean(),
  at: z.iso.datetime(),
});

export const chatSummarySchema = z.object({
  id: uuid,
  kind: chatKind,
  title: z.string().nullable(),
  peer: chatPersonSchema.nullable(),
  memberCount: z.number().int(),
  lastSeq: z.number().int(),
  lastReadSeq: z.number().int(),
  unread: z.number().int(),
  /** somebody mentioned the reader in a message they have not read yet */
  mentioned: z.boolean(),
  /** how far the others have read: ✓✓ on everything up to it (§5.4) */
  othersReadSeq: z.number().int(),
  lastMessage: chatLastMessageSchema.nullable(),
  mutedUntil: z.iso.datetime().nullable(),
  pinnedAt: z.iso.datetime().nullable(),
  lastActivityAt: z.iso.datetime(),
});
export type ChatSummary = z.infer<typeof chatSummarySchema>;

export const chatMemberSchema = chatPersonSchema.extend({
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

/**
 * **A group has no roles** (owner, 2026-09-20): everybody in one may rename it, add and remove
 * people, pin and leave. The one chat with a rule about who writes is the announcements channel,
 * and that rule reads the FIRM's admin role, not a role of the chat's own.
 */
export const addMembersInput = z.object({ userIds: z.array(uuid).min(1).max(200) });
export type AddMembersInput = z.infer<typeof addMembersInput>;

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

// ── files (chat.md §6) ─────────────────────────────────────────────────────────

/** At most ten files a message (§6.1); each is the library's own 25 MB. */
export const CHAT_FILES_MAX = 10;

/**
 * A file a message carries, as the conversation draws it. Its name, size and type are plain, like
 * every file name in the CRM (§9); its bytes are sealed and come through the chat's own routes,
 * which ask whether the reader is in a chat holding a live message that carries it (§6.3).
 */
export const chatFileSchema = z.object({
  fileId: uuid,
  name: z.string(),
  size: z.number().int(),
  /** what its bytes said it was at upload, never what the browser claimed */
  detectedMime: z.string().nullable(),
  /** which of the CRM's viewers opens it; null is a download */
  view: z.enum(["pdf", "image", "text", "csv"]).nullable(),
  /** the small JPEG the sender's browser drew (§6.2); null means it shows as a card */
  previewFileId: uuid.nullable(),
  position: z.number().int(),
});
export type ChatFile = z.infer<typeof chatFileSchema>;

/**
 * What an upload answers with, before the message is sent (§6.1): the file is stored and waiting,
 * and the send names it. Until then only its uploader can see it, and an upload never sent is
 * swept away the next night.
 */
export const chatUploadSchema = chatFileSchema.omit({ position: true });
export type ChatUpload = z.infer<typeof chatUploadSchema>;

/** One row of a chat's Files tab (§6.4): the file, and the message it came in. */
export const chatFileItemSchema = chatFileSchema.extend({
  messageId: uuid,
  seq: z.number().int(),
  senderId: uuid.nullable(),
  at: z.iso.datetime(),
});
export type ChatFileItem = z.infer<typeof chatFileItemSchema>;

export const chatFilesPageSchema = z.object({
  files: z.array(chatFileItemSchema),
  /** there are older ones below this page */
  more: z.boolean(),
});
export type ChatFilesPage = z.infer<typeof chatFilesPageSchema>;

/**
 * **How much every chat is holding** (chat.md §6.5), for the Chats pane in Files and for the tree's
 * own totals. One row per chat the reader is in that still carries a file, largest first.
 *
 * A file forwarded into three chats is in all three: each chat DOES hold it, and the reader deletes
 * it in each. So these do not sum to what the bucket holds, and the firm's own figure on
 * Settings → System counts each file once (and its photos' thumbnails, which this leaves out).
 */
export const chatFilesRowSchema = z.object({
  chatId: uuid,
  kind: chatKind,
  title: z.string().nullable(),
  peer: chatPersonSchema.nullable(),
  files: z.number().int(),
  bytes: z.number().int(),
  /** what those bytes are, by kind, largest first; kinds holding nothing are left out */
  byKind: z.array(
    z.object({ kind: z.string(), files: z.number().int(), bytes: z.number().int() }),
  ),
});
export type ChatFilesRow = z.infer<typeof chatFilesRowSchema>;

/** Where a chat's file is being kept (§6.5): a place in the library, and a folder inside it. */
export const keepFileInput = z.object({
  to: placeInput,
  folderId: uuid.optional(),
});
export type KeepFileInput = z.infer<typeof keepFileInput>;

export const chatFilesOverviewSchema = z.object({
  chats: z.array(chatFilesRowSchema),
  /** every chat of this reader together: what the tree's "Chats" node shows */
  all: z.object({ files: z.number().int(), bytes: z.number().int() }),
});
export type ChatFilesOverview = z.infer<typeof chatFilesOverviewSchema>;

/** The tab's box over names, and its "from" filter (§6.4). */
export const chatFilesQuery = z.object({
  q: z.string().trim().max(100).optional(),
  senderId: uuid.optional(),
  /**
   * The page ends below this place in the conversation — and below this file WITHIN it. A message
   * carries up to ten files, so a page can end in the middle of one; a cursor of the place alone
   * asked for "older than this message" and skipped the rest of it (audit, 2026-09-20).
   */
  before: z.coerce.number().int().positive().optional(),
  beforePosition: z.coerce.number().int().min(0).optional(),
});
export type ChatFilesQuery = z.infer<typeof chatFilesQuery>;

// ── messages (chat.md §5) ──────────────────────────────────────────────────────

export const chatMessageKind = z.enum(["text", "poll", "notice"]);
export type ChatMessageKind = z.infer<typeof chatMessageKind>;

/**
 * The lines a chat writes about itself. `role_changed` and `owner_changed` are only ever READ now:
 * they belong to lines written before a group lost its roles (owner, 2026-09-20).
 */
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
  /** what it carries, in the order they were sent (§6.1) */
  files: z.array(chatFileSchema),
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
    /**
     * Files already uploaded into this chat by this sender and not yet sent (§6.1), newest last.
     * Each names its photo preview, uploaded beside it.
     */
    files: z
      .array(z.object({ fileId: uuid, previewFileId: uuid.nullable().optional() }))
      .max(CHAT_FILES_MAX)
      .optional(),
  })
  .refine(
    (v) => (v.text?.trim() ?? "") !== "" || v.poll || (v.files?.length ?? 0) > 0,
    "A message needs something in it",
  )
  .refine((v) => !(v.poll && v.replyToId), "A poll cannot be a reply")
  .refine((v) => !(v.poll && (v.files?.length ?? 0) > 0), "A poll carries no files");
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

// ── the word search (chat.md §8) ───────────────────────────────────────────────

/** The shortest word the search knows: a prefix is stored from three letters (§8). */
export const SEARCH_MIN_WORD = 3;

/**
 * **Two boxes, one query** (§8): without `chatId` it searches every chat the reader is in, with it
 * that one. A word matches the words that start with it, and every word must be found somewhere.
 */
export const chatSearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  chatId: uuid.optional(),
  senderId: uuid.optional(),
  /** a day, inclusive, as the browser's date field gives it */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  hasFiles: z.stringbool().optional(),
  page: z.coerce.number().int().min(0).max(100).optional(),
});
export type ChatSearchQuery = z.infer<typeof chatSearchQuery>;

export const chatSearchHitSchema = z.object({
  messageId: uuid,
  chatId: uuid,
  /** what to call the chat to the person searching, who is in it */
  chatLabel: z.string(),
  seq: z.number().int(),
  authorId: uuid.nullable(),
  at: z.iso.datetime(),
  /** the words around the first one that matched, on one line */
  snippet: z.string(),
  files: z.number().int(),
});
export type ChatSearchHit = z.infer<typeof chatSearchHitSchema>;

export const chatSearchPageSchema = z.object({
  hits: z.array(chatSearchHitSchema),
  people: z.array(chatPersonSchema),
  more: z.boolean(),
  /**
   * The search read as many candidates as it takes at a time and stopped there, so older messages
   * that also hold the words are not in this answer. The box says so and asks for a narrower
   * search; it is not another page, and offering one gave a "more" that answered with nothing
   * (audit, 2026-09-20).
   */
  narrowed: z.boolean(),
});
export type ChatSearchPage = z.infer<typeof chatSearchPageSchema>;

/** Who has read a message, and when they last read in that chat (§5.4). */
export const readBySchema = z.object({
  people: z.array(chatPersonSchema.extend({ at: z.iso.datetime().nullable() })),
});
export type ReadBy = z.infer<typeof readBySchema>;

export const markReadInput = z.object({ seq: z.number().int().min(0) });
export type MarkReadInput = z.infer<typeof markReadInput>;

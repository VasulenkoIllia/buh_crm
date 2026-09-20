import { createHash } from "node:crypto";
import type {
  ChatMessage,
  ChatMessagePage,
  EditMessageInput,
  ForwardInput,
  HistoryQuery,
  ReadBy,
  SendMessageInput,
  VoteInput,
} from "@shared/schema/chat.js";
import type { User } from "../../generated/prisma/client.js";
import { record } from "../../core/activity.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../core/errors.js";
import { personName } from "../../core/names.js";
import { publish } from "../../core/realtime.js";
import * as attachments from "./chat.files.js";
import * as repo from "./chat.repository.js";
import * as search from "./chat.search.js";
import { openOptions, openText, sealOptions, sealText } from "./chat.sealing.js";
import { requireMember, requireWriter } from "./chat.service.js";

/**
 * **Messages** (chat.md §5): sending, editing, deleting for everyone, replying, forwarding,
 * reacting, pinning, mentioning and polls. Who may read them is `chat.service.ts`: every one of
 * these starts with the caller's active membership of the chat.
 *
 * **A message's place (`seq`) is taken under the chat's row lock** and its text is sealed before it
 * is written, so nothing a person wrote is ever in a plain column. The tab hears `chat_message`
 * with the chat and the place, and fetches the message through the ordinary route: the event
 * carries no text (§7.1).
 *
 * **A send is idempotent.** The author names the send (`clientMessageId`), and a retry after a lost
 * connection finds the first one and answers with it rather than posting twice.
 */

const PAGE = 50;
/** The first line of a quoted message, as a reply shows it. */
const PREVIEW = 120;

type MessageRow = repo.MessageRow;

// ── who may write ──────────────────────────────────────────────────────────────

type Membership = Awaited<ReturnType<typeof requireMember>>;

/**
 * **A group has no roles** (owner, 2026-09-20), so the only brake left on acting over somebody
 * else's message is the FIRM's admin — and it is left exactly where something is destroyed or
 * broadcast: deleting another person's message, and the announcements channel.
 */
const firmAdmin = (user: User) => user.role === "admin";

// ── what a message looks like ──────────────────────────────────────────────────

function previewOf(row: {
  deletedAt: Date | null;
  ciphertext: Uint8Array | null;
  iv: Uint8Array | null;
  authTag: Uint8Array | null;
  keyVersion: number;
}): string | null {
  const text = openText(row);
  if (text === null) return null;
  const line = text.split("\n")[0].trim();
  return line.length > PREVIEW ? `${line.slice(0, PREVIEW)}…` : line;
}

/**
 * **A deleted message is a tombstone and nothing else** (§5.3): the row stays so the chat's places
 * have no hole, but what it carried is not part of it any more. The files, the poll and the
 * reactions are left out here rather than at every reader — the conversation used to draw the photo
 * of a message that said "Message deleted" above it (audit, 2026-09-20), and a page cached before
 * the delete would do it again if this were the screen's job.
 */
function toMessage(row: MessageRow): ChatMessage {
  const gone = row.deletedAt !== null;
  const reactions = new Map<string, string[]>();
  for (const r of row.reactions) {
    reactions.set(r.emoji, [...(reactions.get(r.emoji) ?? []), r.userId]);
  }
  const votes = new Map<number, string[]>();
  for (const v of row.poll?.votes ?? []) {
    votes.set(v.option, [...(votes.get(v.option) ?? []), v.userId]);
  }
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    authorId: row.authorId,
    text: openText(row),
    notice: row.notice ? { code: row.notice, userIds: row.noticeUserIds } : null,
    replyTo: row.replyTo
      ? {
          id: row.replyTo.id,
          seq: row.replyTo.seq,
          authorId: row.replyTo.authorId,
          preview: previewOf(row.replyTo),
          deleted: row.replyTo.deletedAt !== null,
        }
      : null,
    forwardedFromId: row.forwardedFromId,
    mentions: row.mentions,
    reactions: gone ? [] : [...reactions].map(([emoji, userIds]) => ({ emoji, userIds })),
    files: gone ? [] : attachments.filesOf(row.files),
    poll:
      row.poll && !gone
        ? {
            multiple: row.poll.multiple,
            options: openOptions(row.poll),
            closedAt: row.poll.closedAt?.toISOString() ?? null,
            votes: [...votes].map(([option, userIds]) => ({ option, userIds })),
          }
        : null,
    pinned: row.pin !== null && !gone,
    editedAt: row.editedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    deletedByOther: row.deletedAt !== null && row.deletedById !== row.authorId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The people a page names: its authors, whom its notices are about, and who it was forwarded from. */
async function peopleIn(messages: readonly ChatMessage[]) {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.authorId) ids.add(m.authorId);
    if (m.forwardedFromId) ids.add(m.forwardedFromId);
    if (m.replyTo?.authorId) ids.add(m.replyTo.authorId);
    for (const id of m.notice?.userIds ?? []) ids.add(id);
    // the mentioned, so `@Petro Marchenko` still reads as a name after Petro has left the group
    for (const id of m.mentions) ids.add(id);
    for (const r of m.reactions) for (const id of r.userIds) ids.add(id);
    for (const v of m.poll?.votes ?? []) for (const id of v.userIds) ids.add(id);
  }
  return ids.size === 0 ? [] : repo.peopleByIds([...ids]);
}

async function page(rows: MessageRow[], more: boolean): Promise<ChatMessagePage> {
  const messages = rows.map(toMessage);
  return { messages, people: await peopleIn(messages), more };
}

// ── reading ────────────────────────────────────────────────────────────────────

export async function history(
  user: User,
  chatId: string,
  query: HistoryQuery,
): Promise<ChatMessagePage> {
  await requireMember(chatId, user.id);
  const { rows, more } = await repo.messagePage(chatId, {
    before: query.before,
    after: query.after,
    limit: query.limit ?? PAGE,
  });
  return page(rows, more);
}

export async function pinned(user: User, chatId: string): Promise<ChatMessagePage> {
  await requireMember(chatId, user.id);
  return page(await repo.pinnedMessages(chatId), false);
}

/** The message, and the caller's membership of the chat it is in. */
async function messageFor(user: User, messageId: string) {
  const row = await repo.messageById(messageId);
  if (!row) throw new NotFoundError("Message not found");
  const m = await requireMember(row.chatId, user.id);
  return { row, m };
}

async function tell(
  chat: { id: string },
  members: readonly { userId: string }[],
  event: "chat_message" | "chat_message_changed",
  seq: number,
) {
  await publish(
    members.map((x) => x.userId),
    event,
    { chatId: chat.id, seq },
  );
}

// ── sending ────────────────────────────────────────────────────────────────────

export async function send(
  user: User,
  chatId: string,
  input: SendMessageInput,
): Promise<ChatMessage> {
  const m = await requireMember(chatId, user.id);
  requireWriter(m, user);

  // the same send, retried after a lost connection: the first one is the answer. Keyed by the chat
  // as well, so a retry that reached another chat is a message there rather than this one's twin
  const already = await repo.sentAlready(chatId, user.id, input.clientMessageId);
  if (already) return toMessage(already);

  if (input.replyToId) {
    const original = await repo.messageById(input.replyToId);
    if (!original || original.chatId !== chatId) {
      throw new ValidationError("That message is not in this chat");
    }
  }
  const members = new Set(m.chat.members.map((x) => x.userId));
  const mentions = [...new Set(input.mentions ?? [])].filter((id) => members.has(id));
  const text = input.text?.trim() ?? "";
  // what the sender uploaded a moment ago, checked before the place is taken (§6.1)
  const carried = await attachments.forSend(chatId, user, input.files ?? []);
  const at = new Date();

  let messageId: string;
  try {
    messageId = await repo.transaction(async (tx) => {
      const seq = await repo.nextSeq(tx, chatId, at);
      const { id } = await repo.insertMessageTx(tx, {
        chatId,
        seq,
        authorId: user.id,
        clientMessageId: input.clientMessageId,
        sealed: text ? sealText(text) : null,
        replyToId: input.replyToId,
        mentions,
        kind: input.poll ? "poll" : "text",
        at,
      });
      if (input.poll) {
        await repo.insertPollTx(tx, id, input.poll.multiple, sealOptions(input.poll.options));
      }
      if (carried.length > 0) {
        // the same question `forSend` asked, asked again under a lock: two sends naming one upload in
        // the same instant both passed it outside the transaction (review, 2026-09-20)
        const ids = carried.flatMap((f) => [
          f.fileId,
          ...(f.previewFileId ? [f.previewFileId] : []),
        ]);
        if (!(await repo.claimUploadsTx(tx, chatId, user.id, ids))) {
          throw new ValidationError("That file is not ready to send");
        }
        await repo.linkFilesTx(tx, id, carried);
      }
      // the words it can be found by, written with it rather than after it (§8)
      await search.indexTx(tx, chatId, id, [text, ...(input.poll?.options ?? [])]);
      await repo.markSentTx(tx, chatId, user.id, seq, mentions);
      return id;
    });
  } catch (err) {
    // the retry `sentAlready` is for, arriving while the FIRST one is still in flight: it misses
    // the read above, waits on the chat's lock, and then hits the unique key. That is the send
    // succeeding, not failing, and telling the composer 409 would lose the message it holds
    // (audit, 2026-09-20)
    if ((err as { code?: string }).code !== "P2002") throw err;
    const first = await repo.sentAlready(chatId, user.id, input.clientMessageId);
    if (!first) throw err;
    return toMessage(first);
  }

  const saved = await repo.messageById(messageId);
  await tell(m.chat, m.chat.members, "chat_message", saved!.seq);
  return toMessage(saved!);
}

export async function edit(
  user: User,
  messageId: string,
  input: EditMessageInput,
): Promise<ChatMessage> {
  const { row, m } = await messageFor(user, messageId);
  if (row.authorId !== user.id) throw new ForbiddenError("Only its author edits a message");
  if (row.deletedAt) throw new ValidationError("This message was deleted");
  if (row.kind === "notice")
    throw new ValidationError("This line was written by the chat itself");
  if (row.poll && row.poll.votes.length > 0) {
    throw new ValidationError("A poll cannot be changed once somebody has voted");
  }
  await repo.editMessage(messageId, sealText(input.text), new Date());
  await search.reindex(row.chatId, messageId, [
    input.text,
    ...(row.poll ? openOptions(row.poll) : []),
  ]);
  await tell(m.chat, m.chat.members, "chat_message_changed", row.seq);
  return toMessage((await repo.messageById(messageId))!);
}

/**
 * **A delete for everyone** (§5.3): its author any time, and the FIRM's admin anywhere they are a
 * member — a group has no admins of its own since stage C (§4.3). The text is destroyed at once; the row stays so the chat's places have no
 * hole, and the log keeps who deleted whose message, in which chat, and no word of it (§12.1).
 */
export async function remove(user: User, messageId: string): Promise<ChatMessage> {
  const { row, m } = await messageFor(user, messageId);
  const mine = row.authorId === user.id;
  const asAdmin = firmAdmin(user);
  if (!mine && !asAdmin)
    throw new ForbiddenError("Only its author or a firm admin deletes a message");
  if (row.kind === "notice")
    throw new ValidationError("This line was written by the chat itself");
  if (row.deletedAt) return toMessage(row);

  const at = new Date();
  // the count, not a void: two clicks on one message describe the act once (audit, 2026-09-20)
  const deleted = await repo.deleteMessage(messageId, user.id, at);
  // **Said as soon as it is done**, before the two awaits below, either of which can throw — a
  // lock that waited too long, a bucket that would not answer. The text is already destroyed for
  // good at this point, so a throw that took the row with it would leave the log saying the
  // delete FAILED, about the one act `shared/activity.ts` says the log must hold
  // (audit, 2026-09-20).
  if (deleted) {
    const author = row.authorId ? await repo.findPerson(row.authorId) : null;
    record("chat_message.deleted", {
      subjectId: messageId,
      subjectLabel: whichChat(m),
      changes: { author: mine ? "their own" : personName(author) },
    });
  }
  // the text is gone, and so are the words it could be found by (§8)
  await search.forget(messageId);
  // its files go with it unless another live message still carries them; what that removed is
  // written to the log by the thunk, which runs whatever happened
  const sayWhatWentWithIt = await attachments.onMessageDeleted(messageId);
  sayWhatWentWithIt();
  await tell(m.chat, m.chat.members, "chat_message_changed", row.seq);
  return toMessage((await repo.messageById(messageId))!);
}

/**
 * The name a forwarded copy is filed under, so the same forward retried lands once: a uuid derived
 * from the source and the chat it is going into (`clientMessageId` is a uuid column).
 */
function forwardId(sourceId: string, chatId: string): string {
  const hash = createHash("sha256").update(`forward:${sourceId}:${chatId}`).digest("hex");
  const v = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${
    "89ab"[parseInt(hash[16], 16) % 4]
  }${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  return v;
}

/** What the log calls the chat: a group by its title, everything else by what it is (§12.1). */
function whichChat(m: Membership): string {
  switch (m.chat.kind) {
    case "group":
      // never the title: the log is read by people who are not in the group (chat.service.ts)
      return "a group";
    case "announcements":
      return "the announcements channel";
    case "saved":
      return "Saved messages";
    default:
      return "a direct chat";
  }
}

/**
 * **Forwarding copies the words into another chat** (§5.2), marked with whom they came from. The
 * sender must be in both chats and able to write in the one they are sending to.
 */
export async function forward(user: User, input: ForwardInput): Promise<void> {
  const sources = await repo.messagesById(input.messageIds);
  if (sources.length !== new Set(input.messageIds).size) {
    throw new NotFoundError("Message not found");
  }
  for (const source of sources) {
    await requireMember(source.chatId, user.id);
    if (source.deletedAt) throw new ValidationError("A deleted message cannot be forwarded");
    if (source.kind !== "text")
      throw new ValidationError("Only a message's words are forwarded");
  }

  for (const chatId of new Set(input.toChatIds)) {
    const m = await requireMember(chatId, user.id);
    requireWriter(m, user);
    for (const source of sources) {
      // the source, read again at the moment it is copied: deleted since, and there is nothing to
      // forward; edited since, and these are the words it says NOW; a file gone since is not in
      // this list either (reviews, 2026-09-20). The FILES travel with it and reuse the same objects
      // in the bucket (§6.3): a photo sent on to three chats is one file, which is why the link is
      // a table
      const fresh = await attachments.sourceForForward(source.id);
      if (!fresh) continue;
      // **the same forward twice is one copy.** A forward is one request into many chats, each in
      // its own transaction, so a connection lost halfway leaves some of them done; a retry with a
      // fresh id per copy duplicated every one that had already landed. Naming the copy after the
      // source and its destination makes the retry find its own row and stop, the way `send` does
      // with the composer's id (audit, 2026-09-20)
      const copyId = forwardId(source.id, chatId);
      if (await repo.sentAlready(chatId, user.id, copyId)) continue;
      const text = openText(fresh);
      const carried = fresh.files;
      if (text === null && carried.length === 0) continue;
      const at = new Date();
      const seq = await repo.transaction(async (tx) => {
        const seq = await repo.nextSeq(tx, chatId, at);
        const { id } = await repo.insertMessageTx(tx, {
          chatId,
          seq,
          authorId: user.id,
          clientMessageId: copyId,
          sealed: text === null ? null : sealText(text),
          // a message forwarded on keeps the first author, as Telegram does
          forwardedFromId: source.forwardedFromId ?? source.authorId,
          at,
        });
        if (carried.length > 0) await repo.copyLinksTx(tx, id, carried);
        if (text !== null) await search.indexTx(tx, chatId, id, [text]);
        await repo.markSentTx(tx, chatId, user.id, seq, []);
        return seq;
      });
      await tell(m.chat, m.chat.members, "chat_message", seq);
    }
  }
}

// ── reacting, pinning, voting ──────────────────────────────────────────────────

export async function react(
  user: User,
  messageId: string,
  emoji: string,
): Promise<ChatMessage> {
  const { row, m } = await messageFor(user, messageId);
  if (row.deletedAt) throw new ValidationError("This message was deleted");
  await repo.toggleReaction(messageId, user.id, emoji);
  await tell(m.chat, m.chat.members, "chat_message_changed", row.seq);
  return toMessage((await repo.messageById(messageId))!);
}

/** Pinned by anybody in a direct chat or a group; in the channel, by a firm admin (§5.2). */
function requirePinner(m: Membership, user: User) {
  if (m.chat.kind === "announcements" && user.role !== "admin") {
    throw new ForbiddenError("Only an admin pins in the announcements channel");
  }
}

export async function setPinned(
  user: User,
  messageId: string,
  pinned: boolean,
): Promise<ChatMessage> {
  const { row, m } = await messageFor(user, messageId);
  requirePinner(m, user);
  if (pinned && row.deletedAt) throw new ValidationError("This message was deleted");
  if (pinned) await repo.pinMessage(messageId, row.chatId, user.id);
  else await repo.unpinMessage(messageId);
  await tell(m.chat, m.chat.members, "chat_message_changed", row.seq);
  return toMessage((await repo.messageById(messageId))!);
}

export async function vote(
  user: User,
  messageId: string,
  input: VoteInput,
): Promise<ChatMessage> {
  const { row, m } = await messageFor(user, messageId);
  if (!row.poll) throw new ValidationError("This message is not a poll");
  if (row.poll.closedAt) throw new ValidationError("This poll is closed");
  const options = [...new Set(input.options)];
  if (!row.poll.multiple && options.length > 1) {
    throw new ValidationError("This poll takes one answer");
  }
  const count = openOptions(row.poll).length;
  if (options.some((o) => o >= count)) throw new ValidationError("No such option");
  await repo.replaceVotes(messageId, user.id, options);
  await tell(m.chat, m.chat.members, "chat_message_changed", row.seq);
  return toMessage((await repo.messageById(messageId))!);
}

export async function closePoll(user: User, messageId: string): Promise<ChatMessage> {
  const { row, m } = await messageFor(user, messageId);
  if (!row.poll) throw new ValidationError("This message is not a poll");
  if (row.authorId !== user.id && !firmAdmin(user)) {
    throw new ForbiddenError("Only its author or a firm admin closes a poll");
  }
  if (!row.poll.closedAt) await repo.closePoll(messageId, user.id, new Date());
  await tell(m.chat, m.chat.members, "chat_message_changed", row.seq);
  return toMessage((await repo.messageById(messageId))!);
}

// ── read markers and typing (chat.md §5.4) ─────────────────────────────────────

/**
 * **How far the reader has read their own chat.** It moves forward only, never past what the chat
 * holds, and it tells the others so an author sees ✓✓ and the reader's own other tabs catch up.
 *
 * It writes no activity row at all (`activity: "none"`, §12.2): it is the reader's own place in a
 * conversation, moved by scrolling.
 */
export async function markRead(
  user: User,
  chatId: string,
  seq: number,
): Promise<{ seq: number }> {
  const m = await requireMember(chatId, user.id);
  const upTo = Math.min(seq, m.chat.lastSeq);
  if (upTo <= m.lastReadSeq) return { seq: m.lastReadSeq };
  const moved = await repo.markRead(chatId, user.id, upTo, new Date());
  if (moved) {
    await publish(
      m.chat.members.map((x) => x.userId),
      "chat_read",
      { chatId, userId: user.id, seq: upTo },
    );
  }
  return { seq: upTo };
}

/** Who has read this message, with when each of them last read in the chat (§5.4). */
export async function readBy(user: User, messageId: string): Promise<ReadBy> {
  const { row } = await messageFor(user, messageId);
  const readers = await repo.readersOf(row.chatId, row.seq);
  return {
    people: readers.map((r) => ({ ...r.user, at: r.lastReadAt?.toISOString() ?? null })),
  };
}

/**
 * **"Olena is typing…"**, for five seconds, stored nowhere. Only somebody who may write can be
 * typing, so a chat that is read only (a blocked colleague, the channel) sends nothing. It writes
 * no activity row either.
 */
export async function typing(user: User, chatId: string): Promise<void> {
  const m = await requireMember(chatId, user.id);
  requireWriter(m, user);
  const others = m.chat.members.map((x) => x.userId).filter((id) => id !== user.id);
  await publish(others, "typing", { chatId, userId: user.id });
}

import type {
  AddMembersInput,
  ChatDetail,
  ChatPeople,
  ChatSettingsInput,
  ChatSummary,
  CreateGroupInput,
  MuteFor,
  SetMemberRoleInput,
  UpdateGroupInput,
} from "@shared/schema/chat.js";
import type { ChatMemberRole, Prisma, User } from "../../generated/prisma/client.js";
import { record } from "../../core/activity.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../core/errors.js";
import { personName } from "../../core/names.js";
import { publish } from "../../core/realtime.js";
import { ANNOUNCEMENTS_KEY } from "./chat.bootstrap.js";
import * as repo from "./chat.repository.js";
import { openGroup, openText, sealGroup } from "./chat.sealing.js";

/**
 * **Chats and who is in them** (chat.md §4): the list, the four kinds, groups with their owner and
 * admins, the reader's own settings, and what a block does (§11). Messages are
 * `chat.messages.ts` (step A.3).
 *
 * **One rule decides reading** (§4.4): an ACTIVE membership of the chat. A person who is not in a
 * chat, a firm admin included, is told it does not exist, the way a record they may not see is
 * everywhere else in the CRM. The `chat` gate only decides whether a person has the chat at all.
 *
 * Every change to a group's people happens under the chat's row lock, and the caller's own role is
 * read again inside it, so two admins acting at once cannot both remove the last owner.
 */

type Membership = repo.MembershipRow;
type ChatRow = Membership["chat"];

const MUTE_MS: Record<Exclude<MuteFor, "off" | "forever">, number> = {
  hour: 60 * 60 * 1000,
  eight_hours: 8 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
};
/** "Muted for good" is a date nobody will reach. */
const FOREVER = new Date("9999-12-31T00:00:00Z");

// ── reading ──────────────────────────────────────────────────────────────────

function titleOf(chat: Pick<ChatRow, "kind" | "ciphertext" | "iv" | "authTag" | "keyVersion">) {
  return chat.kind === "group" ? (openGroup(chat)?.title ?? null) : null;
}

/** The first line of the newest message, as the list shows it. */
const PREVIEW = 120;

function lastMessageOf(chat: ChatRow): ChatSummary["lastMessage"] {
  const last = chat.messages[0];
  if (!last) return null;
  const text = openText(last);
  const line = text?.split("\n")[0].trim() ?? null;
  return {
    seq: last.seq,
    authorId: last.authorId,
    kind: last.kind,
    notice: last.notice,
    preview: line && line.length > PREVIEW ? `${line.slice(0, PREVIEW)}…` : line,
    deleted: last.deletedAt !== null,
    at: last.createdAt.toISOString(),
  };
}

function summaryOf(m: Membership, meId: string, now = Date.now()): ChatSummary {
  const { chat } = m;
  const peer =
    chat.kind === "direct" ? (chat.members.find((x) => x.userId !== meId)?.user ?? null) : null;
  return {
    id: chat.id,
    kind: chat.kind,
    title: titleOf(chat),
    peer,
    myRole: m.role,
    memberCount: chat.members.length,
    lastSeq: chat.lastSeq,
    lastReadSeq: m.lastReadSeq,
    unread: Math.max(0, chat.lastSeq - m.lastReadSeq),
    mentioned: m.lastMentionSeq > m.lastReadSeq,
    lastMessage: lastMessageOf(chat),
    othersReadSeq: chat.members.reduce(
      (far, x) => (x.userId === meId ? far : Math.max(far, x.lastReadSeq)),
      0,
    ),
    mutedUntil:
      m.mutedUntil && m.mutedUntil.getTime() > now ? m.mutedUntil.toISOString() : null,
    pinnedAt: m.pinnedAt?.toISOString() ?? null,
    lastActivityAt: chat.lastActivityAt.toISOString(),
  };
}

function detailOf(m: Membership, meId: string): ChatDetail {
  return {
    ...summaryOf(m, meId),
    description: m.chat.kind === "group" ? (openGroup(m.chat)?.description ?? null) : null,
    members: m.chat.members.map((x) => ({
      ...x.user,
      role: x.role,
      joinedAt: x.joinedAt.toISOString(),
      readSeq: x.lastReadSeq,
      lastReadAt: x.lastReadAt?.toISOString() ?? null,
    })),
  };
}

/**
 * **What a list shows** (§4.2): a direct chat once somebody has written in it, a chat the reader
 * hid only until something newer arrives, pinned first in the order pinned, then the newest.
 */
function listed(m: Membership): boolean {
  if (m.chat.kind === "direct" && m.chat.lastSeq === 0) return false;
  return !(m.hiddenAt && m.hiddenAt >= m.chat.lastActivityAt);
}

function byListOrder(a: ChatSummary, b: ChatSummary): number {
  if (a.pinnedAt && b.pinnedAt) return a.pinnedAt.localeCompare(b.pinnedAt);
  if (a.pinnedAt || b.pinnedAt) return a.pinnedAt ? -1 : 1;
  return b.lastActivityAt.localeCompare(a.lastActivityAt);
}

/**
 * The reader's chats. An active person with no place in the channel yet (somebody who accepted an
 * invitation since the last boot) is put in it here, the first time they look.
 */
export async function listChats(user: User): Promise<ChatSummary[]> {
  let rows = await repo.membershipsOf(user.id);
  if (user.status === "active" && !rows.some((m) => m.chat.kind === "announcements")) {
    await joinChannel(user.id);
    rows = await repo.membershipsOf(user.id);
  }
  const now = Date.now();
  return rows
    .filter(listed)
    .map((m) => summaryOf(m, user.id, now))
    .sort(byListOrder);
}

/** The reader's membership, or "no such chat": the one check (§4.4). */
export async function requireMember(chatId: string, userId: string): Promise<Membership> {
  const m = await repo.membershipIn(chatId, userId);
  if (!m || m.leftAt) throw new NotFoundError("Chat not found");
  return m;
}

export async function getChat(user: User, chatId: string): Promise<ChatDetail> {
  return detailOf(await requireMember(chatId, user.id), user.id);
}

export async function people(): Promise<ChatPeople> {
  const rows = await repo.colleagues();
  return rows.map(({ chatPresence, ...person }) => ({
    ...person,
    lastSeenAt: chatPresence?.lastSeenAt.toISOString() ?? null,
  }));
}

// ── one chat per place ─────────────────────────────────────────────────────────

/** A direct chat with a colleague: the one there is, or a new one (§4.1). */
export async function openDirect(user: User, otherId: string): Promise<ChatSummary> {
  if (otherId === user.id) {
    throw new ValidationError("Write to yourself in Saved messages");
  }
  const [other] = await repo.findActiveUsers([otherId]);
  if (!other) throw new NotFoundError("Colleague not found");
  const key = `direct:${[user.id, other.id].sort().join(":")}`;
  const chatId = await repo.findOrCreatePlace("direct", key, [user.id, other.id], user.id);
  return summaryOf(await requireMember(chatId, user.id), user.id);
}

export async function openSaved(user: User): Promise<ChatSummary> {
  const chatId = await repo.findOrCreatePlace("saved", `saved:${user.id}`, [user.id], user.id);
  return summaryOf(await requireMember(chatId, user.id), user.id);
}

/** Into the channel, or back into it after an unblock; reading from now, not from its first post. */
export async function joinChannel(userId: string) {
  const channelId = await repo.upsertChannel(ANNOUNCEMENTS_KEY);
  await repo.transaction(async (tx) => {
    const { lastSeq } = await repo.lastSeqTx(tx, channelId);
    const current = await tx.chatMember.findUnique({
      where: { chatId_userId: { chatId: channelId, userId } },
      select: { leftAt: true },
    });
    if (current && !current.leftAt) return;
    await repo.joinTx(tx, channelId, userId, lastSeq, new Date());
  });
}

// ── groups ─────────────────────────────────────────────────────────────────────

function requireGroup(chat: Pick<ChatRow, "kind">) {
  if (chat.kind === "announcements") {
    throw new ValidationError("The announcements channel cannot be changed");
  }
  if (chat.kind !== "group") throw new ValidationError("Only a group can be changed");
}

const MANAGES: readonly ChatMemberRole[] = ["owner", "admin"];

function requireManager(role: ChatMemberRole | undefined) {
  if (!role) throw new NotFoundError("Chat not found");
  if (!MANAGES.includes(role)) throw new ForbiddenError("Only the group's admins can do this");
}

async function activePeople(ids: readonly string[]) {
  const wanted = [...new Set(ids)];
  const found = await repo.findActiveUsers(wanted);
  if (found.length !== wanted.length) {
    throw new ValidationError("Only active colleagues can be in a group");
  }
  return found;
}

/**
 * The next owner when the owner goes (§4.3): the longest-standing admin, or else the
 * longest-standing member. `members` is in joining order and no longer holds the one leaving.
 */
function successorOf(members: readonly { userId: string; role: ChatMemberRole }[]) {
  return members.find((m) => m.role === "admin") ?? members[0] ?? null;
}

/** Tells every tab it concerns to refetch the list and this chat. */
async function announce(chatId: string, people: readonly string[]) {
  await publish([...new Set(people)], "chat_updated", { chatId });
}

export async function createGroup(user: User, input: CreateGroupInput): Promise<ChatDetail> {
  const others = await activePeople(input.memberIds.filter((id) => id !== user.id));
  if (others.length === 0) throw new ValidationError("Add at least one colleague");
  const title = input.title;
  const at = new Date();
  const chatId = await repo.transaction(async (tx) => {
    const { id } = await repo.createGroupTx(
      tx,
      sealGroup({ title, description: input.description || null }),
      user.id,
      others.map((p) => p.id),
      at,
    );
    const seq = await repo.writeNotice(tx, id, "created", [], user.id, at);
    // the creator has seen their own "created"; everybody added has it to read
    await tx.chatMember.update({
      where: { chatId_userId: { chatId: id, userId: user.id } },
      data: { lastReadSeq: seq },
    });
    return id;
  });
  record("chat.created", { subjectId: chatId, subjectLabel: title });
  await announce(chatId, [user.id, ...others.map((p) => p.id)]);
  return getChat(user, chatId);
}

export async function updateGroup(
  user: User,
  chatId: string,
  input: UpdateGroupInput,
): Promise<ChatDetail> {
  const m = await requireMember(chatId, user.id);
  requireGroup(m.chat);
  requireManager(m.role);
  const before = openGroup(m.chat) ?? { title: "", description: null };
  const after = {
    title: input.title ?? before.title,
    description:
      input.description === undefined ? before.description : input.description || null,
  };
  const titleMoved = after.title !== before.title;
  const descriptionMoved = after.description !== before.description;
  if (!titleMoved && !descriptionMoved) return detailOf(m, user.id);

  const at = new Date();
  await repo.transaction(async (tx) => {
    await repo.setGroupWords(tx, chatId, sealGroup(after));
    if (titleMoved) await repo.writeNotice(tx, chatId, "renamed", [], user.id, at);
  });
  const changes: Record<string, unknown> = {};
  if (titleMoved) changes.title = { from: before.title, to: after.title };
  // the words of a description are the group's own, like a message; the log says it changed
  if (descriptionMoved) changes.description = "changed";
  record("chat.renamed", { subjectId: chatId, subjectLabel: after.title, changes });
  await announce(
    chatId,
    m.chat.members.map((x) => x.userId),
  );
  return getChat(user, chatId);
}

export async function addMembers(
  user: User,
  chatId: string,
  input: AddMembersInput,
): Promise<ChatDetail> {
  const m = await requireMember(chatId, user.id);
  requireGroup(m.chat);
  const people = await activePeople(input.userIds);
  const title = titleOf(m.chat);
  const at = new Date();

  const { added, members } = await repo.transaction(async (tx) => {
    await repo.lockChat(tx, chatId);
    const current = await repo.activeMembersTx(tx, chatId);
    requireManager(current.find((x) => x.userId === user.id)?.role);
    const inIt = new Set(current.map((x) => x.userId));
    const added = people.filter((p) => !inIt.has(p.id));
    if (added.length > 0) {
      const { lastSeq } = await repo.lastSeqTx(tx, chatId);
      for (const p of added) await repo.joinTx(tx, chatId, p.id, lastSeq, at);
      await repo.writeNotice(
        tx,
        chatId,
        "member_added",
        added.map((p) => p.id),
        user.id,
        at,
      );
    }
    return { added, members: current.map((x) => x.userId) };
  });

  for (const p of added) {
    record("chat_member.added", {
      subjectId: p.id,
      subjectLabel: personName(p),
      changes: { group: title },
    });
  }
  if (added.length > 0) await announce(chatId, [...members, ...added.map((p) => p.id)]);
  return getChat(user, chatId);
}

export async function removeMember(
  user: User,
  chatId: string,
  targetId: string,
): Promise<ChatDetail> {
  if (targetId === user.id) throw new ValidationError("Leave the group instead");
  const m = await requireMember(chatId, user.id);
  requireGroup(m.chat);
  const title = titleOf(m.chat);
  const at = new Date();

  const members = await repo.transaction(async (tx) => {
    await repo.lockChat(tx, chatId);
    const current = await repo.activeMembersTx(tx, chatId);
    const myRole = current.find((x) => x.userId === user.id)?.role;
    requireManager(myRole);
    const target = current.find((x) => x.userId === targetId);
    if (!target) throw new NotFoundError("Not in this group");
    if (target.role === "owner")
      throw new ForbiddenError("The group's owner cannot be removed");
    if (target.role === "admin" && myRole !== "owner") {
      throw new ForbiddenError("Only the group's owner can remove an admin");
    }
    await repo.leaveTx(tx, chatId, targetId, at);
    await repo.writeNotice(tx, chatId, "member_removed", [targetId], user.id, at);
    return current.map((x) => x.userId);
  });

  const target = await repo.findPerson(targetId);
  record("chat_member.removed", {
    subjectId: targetId,
    subjectLabel: personName(target),
    changes: { group: title },
  });
  await announce(chatId, members);
  return getChat(user, chatId);
}

export async function setMemberRole(
  user: User,
  chatId: string,
  targetId: string,
  input: SetMemberRoleInput,
): Promise<ChatDetail> {
  if (targetId === user.id) throw new ValidationError("Ask another admin to change your role");
  const m = await requireMember(chatId, user.id);
  requireGroup(m.chat);
  const title = titleOf(m.chat);
  const at = new Date();

  const outcome = await repo.transaction(async (tx) => {
    await repo.lockChat(tx, chatId);
    const current = await repo.activeMembersTx(tx, chatId);
    requireManager(current.find((x) => x.userId === user.id)?.role);
    const target = current.find((x) => x.userId === targetId);
    if (!target) throw new NotFoundError("Not in this group");
    if (target.role === "owner") {
      throw new ValidationError("The owner's role changes only by handing ownership on");
    }
    if (target.role === input.role) return null;
    await repo.setRoleTx(tx, chatId, targetId, input.role);
    await repo.writeNotice(tx, chatId, "role_changed", [targetId], user.id, at);
    return { from: target.role, members: current.map((x) => x.userId) };
  });
  if (!outcome) return getChat(user, chatId);

  const target = await repo.findPerson(targetId);
  record("chat_member.role_changed", {
    subjectId: targetId,
    subjectLabel: personName(target),
    changes: { group: title, role: { from: outcome.from, to: input.role } },
  });
  await announce(chatId, outcome.members);
  return getChat(user, chatId);
}

/** The owner hands the group on, and stays in it as an admin (§4.3). */
export async function transferOwner(
  user: User,
  chatId: string,
  targetId: string,
): Promise<ChatDetail> {
  if (targetId === user.id) throw new ValidationError("You already own this group");
  const m = await requireMember(chatId, user.id);
  requireGroup(m.chat);
  const title = titleOf(m.chat);
  const at = new Date();

  const outcome = await repo.transaction(async (tx) => {
    await repo.lockChat(tx, chatId);
    const current = await repo.activeMembersTx(tx, chatId);
    if (current.find((x) => x.userId === user.id)?.role !== "owner") {
      throw new ForbiddenError("Only the group's owner can hand it on");
    }
    const target = current.find((x) => x.userId === targetId);
    if (!target) throw new NotFoundError("Not in this group");
    await repo.setRoleTx(tx, chatId, targetId, "owner");
    await repo.setRoleTx(tx, chatId, user.id, "admin");
    await repo.writeNotice(tx, chatId, "owner_changed", [targetId], user.id, at);
    return { from: target.role, members: current.map((x) => x.userId) };
  });

  const target = await repo.findPerson(targetId);
  record("chat_member.role_changed", {
    subjectId: targetId,
    subjectLabel: personName(target),
    changes: { group: title, role: { from: outcome.from, to: "owner" } },
  });
  await announce(chatId, outcome.members);
  return getChat(user, chatId);
}

/**
 * Anyone may leave a group, and keeps nothing of it on their list (§4.3). An owner who leaves
 * hands it to the longest-standing admin, or else member; the last one out leaves a group nobody
 * sees, and nothing is deleted.
 */
export async function leave(user: User, chatId: string): Promise<void> {
  const m = await requireMember(chatId, user.id);
  if (m.chat.kind === "announcements") {
    throw new ValidationError("Nobody leaves the announcements channel; mute it instead");
  }
  if (m.chat.kind !== "group") throw new ValidationError("Hide this chat instead");
  const title = titleOf(m.chat);
  const at = new Date();

  const members = await repo.transaction(async (tx) => {
    await repo.lockChat(tx, chatId);
    const current = await repo.activeMembersTx(tx, chatId);
    const me = current.find((x) => x.userId === user.id);
    if (!me) throw new NotFoundError("Chat not found");
    await repo.leaveTx(tx, chatId, user.id, at);
    await repo.writeNotice(tx, chatId, "member_left", [user.id], user.id, at);
    const rest = current.filter((x) => x.userId !== user.id);
    const next = me.role === "owner" ? successorOf(rest) : null;
    if (next) {
      await repo.setRoleTx(tx, chatId, next.userId, "owner");
      await repo.writeNotice(tx, chatId, "owner_changed", [next.userId], null, at);
    }
    return current.map((x) => x.userId);
  });

  record("chat_member.left", {
    subjectId: user.id,
    subjectLabel: personName(user),
    changes: { group: title },
  });
  await announce(chatId, members);
}

// ── the reader's own list ──────────────────────────────────────────────────────

/** Mute, pin, hide: the reader's own list, which changes nothing for anybody else (§4.2). */
export async function updateSettings(
  user: User,
  chatId: string,
  input: ChatSettingsInput,
): Promise<ChatSummary> {
  const m = await requireMember(chatId, user.id);
  if (input.hidden && m.chat.kind === "announcements") {
    throw new ValidationError("The announcements channel stays on the list; mute it instead");
  }
  const now = new Date();
  const data: { mutedUntil?: Date | null; pinnedAt?: Date | null; hiddenAt?: Date | null } = {};
  if (input.mute !== undefined) {
    data.mutedUntil =
      input.mute === "off"
        ? null
        : input.mute === "forever"
          ? FOREVER
          : new Date(now.getTime() + MUTE_MS[input.mute]);
  }
  if (input.pinned !== undefined) data.pinnedAt = input.pinned ? (m.pinnedAt ?? now) : null;
  if (input.hidden !== undefined) data.hiddenAt = input.hidden ? now : null;
  await repo.updateOwnSettings(chatId, user.id, data);
  return summaryOf(await requireMember(chatId, user.id), user.id);
}

// ── a block (chat.md §11) ──────────────────────────────────────────────────────

export interface LeftOnBlock {
  chatId: string;
  title: string | null;
  /** everybody who was in it, the blocked person included: whom to tell */
  members: string[];
}

/**
 * **Run inside the block's own transaction** (users.service): the person leaves every group, each
 * group reads "<name> was blocked", ownership passes on where they owned it, and their place in
 * the channel ends. Their messages stay where they are, and their direct chats and Saved messages
 * stay as they are: nothing moves and nothing opens to anybody.
 */
export async function leaveChatsOnBlock(
  tx: Prisma.TransactionClient,
  userId: string,
  at: Date,
): Promise<LeftOnBlock[]> {
  const groups = await repo.activeGroupsOfTx(tx, userId);
  const left: LeftOnBlock[] = [];
  for (const g of groups) {
    await repo.lockChat(tx, g.chatId);
    const current = await repo.activeMembersTx(tx, g.chatId);
    await repo.leaveTx(tx, g.chatId, userId, at);
    await repo.writeNotice(tx, g.chatId, "member_blocked", [userId], null, at);
    const rest = current.filter((x) => x.userId !== userId);
    const next = g.role === "owner" ? successorOf(rest) : null;
    if (next) {
      await repo.setRoleTx(tx, g.chatId, next.userId, "owner");
      await repo.writeNotice(tx, g.chatId, "owner_changed", [next.userId], null, at);
    }
    left.push({
      chatId: g.chatId,
      title: openGroup(g.chat)?.title ?? null,
      members: current.map((x) => x.userId),
    });
  }
  await repo.leaveChannelTx(tx, userId, at);
  return left;
}

/** After the block's transaction: the log, and every tab still open in those groups. */
export async function announceBlock(person: { id: string; name: string }, left: LeftOnBlock[]) {
  for (const g of left) {
    record("chat_member.removed", {
      subjectId: person.id,
      subjectLabel: person.name,
      changes: { group: g.title },
    });
    await announce(g.chatId, g.members);
  }
}

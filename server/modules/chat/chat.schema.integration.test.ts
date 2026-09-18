import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../core/db.js";
import { ANNOUNCEMENTS_KEY, ensureAnnouncementsChannel } from "./chat.bootstrap.js";
import {
  openGroup,
  openOptions,
  openText,
  sealGroup,
  sealOptions,
  sealText,
} from "./chat.sealing.js";

/**
 * **The chat's tables hold their own rules** (chat.md §9, §16), whatever a service forgets: one
 * direct chat per pair, one Saved messages per person, one channel; a title only on a group; a
 * sealed value whole or absent; a notice that speaks only by its code. And the channel's members
 * are the active team, kept so on every boot.
 */

const DOMAIN = "@chat-schema.local";
const chats: string[] = [];
let olena: string;
let petro: string;

async function person(name: string, status: "active" | "blocked" | "invited" = "active") {
  const user = await prisma.user.create({
    data: {
      firstName: name,
      lastName: "Tester",
      email: `${name.toLowerCase()}${DOMAIN}`,
      role: "user",
      status,
    },
  });
  return user.id;
}

async function chat(data: Parameters<typeof prisma.chat.create>[0]["data"]) {
  const row = await prisma.chat.create({ data });
  chats.push(row.id);
  return row.id;
}

async function removeOwn() {
  await prisma.chat.deleteMany({ where: { id: { in: chats } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
}

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  olena = await person("Olena");
  petro = await person("Petro");
});

afterAll(removeOwn);

describe("sealing", () => {
  it("keeps no word of a message in the clear, and opens it again", () => {
    const text = "Petrenko's 1040 is ready to sign";
    const sealed = sealText(text);
    expect(Buffer.from(sealed.ciphertext).toString("utf8")).not.toContain("Petrenko");
    expect(openText(sealed)).toBe(text);
    expect(openText({ ciphertext: null, iv: null, authTag: null, keyVersion: 1 })).toBeNull();
  });

  it("seals a group's title with its description, and a poll's options", () => {
    const info = { title: "Tax season 2025", description: "Returns due 15 April" };
    expect(openGroup(sealGroup(info))).toEqual(info);
    expect(openOptions(sealOptions(["Monday", "Tuesday"]))).toEqual(["Monday", "Tuesday"]);
  });
});

describe("what the tables refuse", () => {
  it("one direct chat per pair, one Saved messages per person", async () => {
    const key = `direct:${[olena, petro].sort().join(":")}`;
    await chat({ kind: "direct", uniqueKey: key });
    await expect(
      prisma.chat.create({ data: { kind: "direct", uniqueKey: key } }),
    ).rejects.toThrow();

    await chat({ kind: "saved", uniqueKey: `saved:${olena}` });
    await expect(
      prisma.chat.create({ data: { kind: "saved", uniqueKey: `saved:${olena}` } }),
    ).rejects.toThrow();
  });

  it("a place for every kind but a group, and a title for a group alone", async () => {
    await expect(prisma.chat.create({ data: { kind: "direct" } })).rejects.toThrow(
      /Chat_one_place/,
    );
    await expect(
      prisma.chat.create({ data: { kind: "group", uniqueKey: `group:${randomUUID()}` } }),
    ).rejects.toThrow(/Chat_one_place/);
    await expect(prisma.chat.create({ data: { kind: "group" } })).rejects.toThrow(
      /Chat_title_only_on_group/,
    );
    await expect(
      prisma.chat.create({
        data: {
          kind: "saved",
          uniqueKey: `saved:${petro}`,
          ...sealGroup({ title: "x", description: null }),
        },
      }),
    ).rejects.toThrow(/Chat_title_only_on_group/);

    const sealed = sealGroup({ title: "Tax season", description: null });
    await expect(
      prisma.chat.create({ data: { kind: "group", ciphertext: sealed.ciphertext } }),
    ).rejects.toThrow(/Chat_sealed_whole/);
    await chat({ kind: "group", ...sealed });
  });

  it("a message in its own place, sent once, and a notice with no text", async () => {
    const chatId = await chat({
      kind: "group",
      ...sealGroup({ title: "Places", description: null }),
    });
    const base = { chatId, authorId: olena, clientMessageId: randomUUID() };

    await expect(prisma.chatMessage.create({ data: { ...base, seq: 0 } })).rejects.toThrow(
      /ChatMessage_seq_positive/,
    );
    await prisma.chatMessage.create({ data: { ...base, seq: 1, ...sealText("first") } });
    await expect(
      prisma.chatMessage.create({ data: { ...base, clientMessageId: randomUUID(), seq: 1 } }),
    ).rejects.toThrow();
    // the same send, retried
    await expect(prisma.chatMessage.create({ data: { ...base, seq: 2 } })).rejects.toThrow();
    // a text with no client id
    await expect(
      prisma.chatMessage.create({ data: { chatId, authorId: olena, seq: 3 } }),
    ).rejects.toThrow(/ChatMessage_notice_shape/);
    // a notice that says something in text
    await expect(
      prisma.chatMessage.create({
        data: {
          chatId,
          seq: 4,
          kind: "notice",
          notice: "renamed",
          ...sealText("the new name"),
        },
      }),
    ).rejects.toThrow(/ChatMessage_notice_shape/);
    // a notice as it should be: a code and whom it is about
    await prisma.chatMessage.create({
      data: { chatId, seq: 4, kind: "notice", notice: "member_added", noticeUserIds: [petro] },
    });
  });

  it("a reaction is an emoji, and a vote names one of ten options", async () => {
    const chatId = await chat({
      kind: "group",
      ...sealGroup({ title: "Votes", description: null }),
    });
    const message = await prisma.chatMessage.create({
      data: {
        chatId,
        seq: 1,
        kind: "poll",
        authorId: olena,
        clientMessageId: randomUUID(),
        ...sealText("Which day?"),
      },
    });
    await prisma.chatPoll.create({
      data: { messageId: message.id, ...sealOptions(["Mon", "Tue"]) },
    });

    await expect(
      prisma.chatReaction.create({
        data: {
          messageId: message.id,
          userId: petro,
          emoji: "a whole sentence of plain text here",
        },
      }),
    ).rejects.toThrow(/ChatReaction_emoji_short/);
    await prisma.chatReaction.create({
      data: { messageId: message.id, userId: petro, emoji: "👍" },
    });

    await expect(
      prisma.chatPollVote.create({
        data: { messageId: message.id, userId: petro, option: 10 },
      }),
    ).rejects.toThrow(/ChatPollVote_option_range/);
    await prisma.chatPollVote.create({
      data: { messageId: message.id, userId: petro, option: 1 },
    });
  });

  it("lets the team be wiped by a test suite: memberships go, messages stay without an author", async () => {
    const gone = await person("Gone");
    const chatId = await chat({
      kind: "group",
      ...sealGroup({ title: "Wiped", description: null }),
    });
    await prisma.chatMember.create({ data: { chatId, userId: gone } });
    const message = await prisma.chatMessage.create({
      data: {
        chatId,
        seq: 1,
        authorId: gone,
        clientMessageId: randomUUID(),
        ...sealText("hi"),
      },
    });

    await prisma.user.delete({ where: { id: gone } });
    expect(await prisma.chatMember.count({ where: { chatId } })).toBe(0);
    const kept = await prisma.chatMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(kept.authorId).toBeNull();
  });
});

describe("the announcements channel", () => {
  it("is made once, holds every active person, and follows a block and an unblock", async () => {
    const blocked = await person("Blocked", "blocked");
    const invited = await person("Invited", "invited");

    const id = await ensureAnnouncementsChannel();
    expect(await ensureAnnouncementsChannel()).toBe(id);
    expect(await prisma.chat.count({ where: { uniqueKey: ANNOUNCEMENTS_KEY } })).toBe(1);

    const active = async (userId: string) =>
      (await prisma.chatMember.findUnique({ where: { chatId_userId: { chatId: id, userId } } }))
        ?.leftAt === null;
    expect(await active(olena)).toBe(true);
    expect(await active(blocked)).toBe(false);
    expect(await active(invited)).toBe(false);

    await prisma.user.update({ where: { id: olena }, data: { status: "blocked" } });
    await ensureAnnouncementsChannel();
    expect(await active(olena)).toBe(false);

    await prisma.user.update({ where: { id: olena }, data: { status: "active" } });
    await ensureAnnouncementsChannel();
    expect(await active(olena)).toBe(true);
  });
});

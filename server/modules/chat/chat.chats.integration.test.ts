import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { prisma } from "../../core/db.js";
import { createPeople, removePeople, type Person } from "../../test/people.js";
import { openTestStream } from "../../test/stream-probe.js";

/**
 * **Chats and who is in them** (chat.md §4, §11, §12.1, §19 "Membership", "Direct and Saved",
 * "Blocking").
 *
 * Through the routes, as a tab uses them: the list, one direct chat per pair, Saved messages,
 * groups with their owner and admins, the reader's own settings, and what a block does. Messages
 * are step A.3.
 */

const DOMAIN = "@chat-chats.local";
let app: Awaited<ReturnType<typeof buildApp>>;
let admin: Person;
let olena: Person;
let petro: Person;
let iryna: Person;
let taras: Person;
let outsider: Person;

type Json = Record<string, unknown> & { members?: { id: string; role: string }[] };

async function call(
  who: Person,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
) {
  const res = await app.inject({
    method,
    url: `/api/chat${url}`,
    headers: { cookie: who.cookie },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, body: (res.body ? res.json() : null) as Json };
}

/** Rows from this test only: the same people are acted on in many, and a row is written late. */
let since = new Date();
beforeEach(() => {
  since = new Date();
});

async function logged(action: string, subjectId: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const row = await prisma.activityEvent.findFirst({
      where: { action, subjectId, occurredAt: { gte: since } },
      orderBy: { occurredAt: "desc" },
      select: { subjectLabel: true, changes: true },
    });
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no ${action} row for ${subjectId} was written`);
}

async function group(owner: Person, title: string, others: Person[]) {
  const res = await call(owner, "POST", "/groups", {
    title,
    memberIds: others.map((p) => p.id),
  });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

async function listOf(who: Person) {
  return (await call(who, "GET", "/chats")).body as unknown as Json[];
}

async function notices(chatId: string) {
  return prisma.chatMessage.findMany({
    where: { chatId, kind: "notice" },
    orderBy: { seq: "asc" },
    select: { notice: true, noticeUserIds: true, authorId: true },
  });
}

async function removeChatsOf(domain: string) {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: domain } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  await prisma.chat.deleteMany({
    where: { kind: { not: "announcements" }, members: { some: { userId: { in: ids } } } },
  });
}

beforeAll(async () => {
  app = await buildApp();
  await removeChatsOf(DOMAIN);
  await removePeople(DOMAIN);
  [admin] = await createPeople(app, DOMAIN, ["Admin"], "admin");
  [olena, petro, iryna, taras, outsider] = await createPeople(app, DOMAIN, [
    "Olena",
    "Petro",
    "Iryna",
    "Taras",
    "Outsider",
  ]);
});

afterAll(async () => {
  await app?.close();
  await removeChatsOf(DOMAIN);
  await removePeople(DOMAIN);
});

describe("the list, direct chats and Saved messages", () => {
  it("puts an active person in the announcements channel the first time they look", async () => {
    const list = await listOf(olena);
    expect(list.some((c) => c.kind === "announcements")).toBe(true);
  });

  it("keeps one direct chat per pair, whoever opens it", async () => {
    const first = await call(olena, "POST", "/direct", { userId: petro.id });
    const back = await call(petro, "POST", "/direct", { userId: olena.id });
    expect(first.status).toBe(200);
    expect(back.body.id).toBe(first.body.id);
    expect((first.body.peer as { id: string }).id).toBe(petro.id);
    // an empty conversation stays off both lists until somebody writes in it
    expect((await listOf(olena)).some((c) => c.id === first.body.id)).toBe(false);
  });

  it("refuses a direct chat with oneself or with nobody", async () => {
    expect((await call(olena, "POST", "/direct", { userId: olena.id })).status).toBe(400);
    expect(
      (await call(olena, "POST", "/direct", { userId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" }))
        .status,
    ).toBe(404);
  });

  it("keeps one Saved messages per person, private to them", async () => {
    const a = await call(olena, "POST", "/saved");
    const b = await call(olena, "POST", "/saved");
    expect(b.body.id).toBe(a.body.id);
    expect(a.body.kind).toBe("saved");
    expect((await call(petro, "GET", `/chats/${a.body.id as string}`)).status).toBe(404);
  });

  it("lists the active team to start a chat with", async () => {
    const people = (await call(olena, "GET", "/people")).body as unknown as { id: string }[];
    expect(people.map((p) => p.id)).toEqual(expect.arrayContaining([petro.id, iryna.id]));
  });
});

describe("groups", () => {
  it("creates a group with its owner, seals its title, and records it", async () => {
    const olenaTab = await openTestStream(app, "/api/chat/stream", { cookie: olena.cookie });
    const petroTab = await openTestStream(app, "/api/chat/stream", { cookie: petro.cookie });
    await olenaTab.next("hello");
    await petroTab.next("hello");

    const chatId = await group(olena, "Tax season 2025", [petro, iryna]);
    const detail = (await call(olena, "GET", `/chats/${chatId}`)).body;
    expect(detail.title).toBe("Tax season 2025");
    expect(detail.myRole).toBe("owner");
    expect(detail.members?.map((m) => m.id).sort()).toEqual(
      [olena.id, petro.id, iryna.id].sort(),
    );

    // the creator has read "created"; the people added have it to read
    expect(detail.unread).toBe(0);
    expect((await call(petro, "GET", `/chats/${chatId}`)).body.unread).toBe(1);

    const row = await prisma.chat.findUniqueOrThrow({ where: { id: chatId } });
    expect(Buffer.from(row.ciphertext!).toString("utf8")).not.toContain("Tax season");
    // the log never names a group: the activity screen is read by people who are not in it
    expect((await logged("chat.created", chatId)).subjectLabel).toBe("a group");

    // every tab of every member hears of it
    expect((await petroTab.next("chat_updated")).data).toEqual({ chatId });
    expect((await olenaTab.next("chat_updated")).data).toEqual({ chatId });
    olenaTab.close();
    petroTab.close();
  });

  it("shows a group to nobody outside it, a firm admin included", async () => {
    const chatId = await group(olena, "Private", [petro]);
    expect((await call(outsider, "GET", `/chats/${chatId}`)).status).toBe(404);
    expect((await call(admin, "GET", `/chats/${chatId}`)).status).toBe(404);
    expect((await listOf(admin)).some((c) => c.id === chatId)).toBe(false);
    expect((await call(admin, "PATCH", `/chats/${chatId}`, { title: "Mine" })).status).toBe(
      404,
    );
  });

  it("refuses a group with nobody else in it, or with somebody who is not active", async () => {
    expect(
      (await call(olena, "POST", "/groups", { title: "Alone", memberIds: [olena.id] })).status,
    ).toBe(400);
    const blocked = await createPeople(app, DOMAIN, ["Gone"]);
    await prisma.user.update({ where: { id: blocked[0].id }, data: { status: "blocked" } });
    expect(
      (await call(olena, "POST", "/groups", { title: "With gone", memberIds: [blocked[0].id] }))
        .status,
    ).toBe(400);
  });

  it("lets its admins change its words, and records that they moved, not what they say", async () => {
    const chatId = await group(olena, "Old name", [petro]);
    expect((await call(petro, "PATCH", `/chats/${chatId}`, { title: "Petro's" })).status).toBe(
      403,
    );

    const renamed = await call(olena, "PATCH", `/chats/${chatId}`, {
      title: "New name",
      description: "Returns and extensions",
    });
    expect(renamed.body.title).toBe("New name");
    expect(renamed.body.description).toBe("Returns and extensions");
    const row = await logged("chat.renamed", chatId);
    expect(row.subjectLabel).toBe("a group");
    // what moved, never to what: neither the old title nor the new one is in the log
    expect(row.changes).toEqual({ title: "changed", description: "changed" });
    expect((await notices(chatId)).map((n) => n.notice)).toEqual(["created", "renamed"]);
  });

  it("adds people, who read from now and see the whole history, and records each", async () => {
    const chatId = await group(olena, "Adding", [petro]);
    expect(
      (await call(petro, "POST", `/chats/${chatId}/members`, { userIds: [iryna.id] })).status,
    ).toBe(403);

    const added = await call(olena, "POST", `/chats/${chatId}/members`, {
      userIds: [iryna.id],
    });
    expect(added.body.members?.map((m) => m.id)).toContain(iryna.id);
    // "Olena added Iryna" is the one thing Iryna has to read
    expect((await call(iryna, "GET", `/chats/${chatId}`)).body.unread).toBe(1);
    const row = await logged("chat_member.added", iryna.id);
    expect(row.changes).toEqual({ group: "a group" });
    const last = (await notices(chatId)).at(-1)!;
    expect(last).toMatchObject({ notice: "member_added", noticeUserIds: [iryna.id] });
  });

  it("lets an admin take out a member but not another admin, and never the owner", async () => {
    const chatId = await group(olena, "Removing", [petro, iryna, taras]);
    await call(olena, "PUT", `/chats/${chatId}/members/${petro.id}/role`, { role: "admin" });
    await call(olena, "PUT", `/chats/${chatId}/members/${iryna.id}/role`, { role: "admin" });

    expect((await call(petro, "DELETE", `/chats/${chatId}/members/${iryna.id}`)).status).toBe(
      403,
    );
    expect((await call(petro, "DELETE", `/chats/${chatId}/members/${olena.id}`)).status).toBe(
      403,
    );
    expect((await call(petro, "DELETE", `/chats/${chatId}/members/${taras.id}`)).status).toBe(
      200,
    );
    expect((await call(taras, "GET", `/chats/${chatId}`)).status).toBe(404);
    expect((await listOf(taras)).some((c) => c.id === chatId)).toBe(false);
    expect((await logged("chat_member.removed", taras.id)).changes).toEqual({
      group: "a group",
    });

    expect((await call(olena, "DELETE", `/chats/${chatId}/members/${iryna.id}`)).status).toBe(
      200,
    );
  });

  it("names admins and records the role that moved", async () => {
    const chatId = await group(olena, "Roles", [petro]);
    const res = await call(olena, "PUT", `/chats/${chatId}/members/${petro.id}/role`, {
      role: "admin",
    });
    expect(res.body.members?.find((m) => m.id === petro.id)?.role).toBe("admin");
    expect((await logged("chat_member.role_changed", petro.id)).changes).toEqual({
      group: "a group",
      role: { from: "member", to: "admin" },
    });
    // the owner's role moves only by handing the group on
    expect(
      (
        await call(petro, "PUT", `/chats/${chatId}/members/${olena.id}/role`, {
          role: "member",
        })
      ).status,
    ).toBe(400);
  });

  it("hands ownership on, by the owner alone", async () => {
    const chatId = await group(olena, "Handing on", [petro]);
    expect(
      (await call(petro, "POST", `/chats/${chatId}/owner`, { userId: petro.id })).status,
    ).toBe(400);
    const res = await call(olena, "POST", `/chats/${chatId}/owner`, { userId: petro.id });
    const roles = Object.fromEntries(res.body.members!.map((m) => [m.id, m.role]));
    expect(roles).toEqual({ [olena.id]: "admin", [petro.id]: "owner" });
  });

  it("lets anyone leave; an owner's group passes to the longest-standing admin", async () => {
    const chatId = await group(olena, "Leaving", [petro, iryna]);
    await call(olena, "PUT", `/chats/${chatId}/members/${iryna.id}/role`, { role: "admin" });

    expect((await call(olena, "POST", `/chats/${chatId}/leave`)).status).toBe(200);
    expect((await call(olena, "GET", `/chats/${chatId}`)).status).toBe(404);
    const roles = Object.fromEntries(
      (await call(petro, "GET", `/chats/${chatId}`)).body.members!.map((m) => [m.id, m.role]),
    );
    expect(roles[iryna.id]).toBe("owner");
    expect((await logged("chat_member.left", olena.id)).changes).toEqual({ group: "a group" });
    expect((await notices(chatId)).map((n) => n.notice).slice(-2)).toEqual([
      "member_left",
      "owner_changed",
    ]);
  });

  it("does not let anybody leave the channel, a direct chat or Saved messages", async () => {
    const channel = (await listOf(olena)).find((c) => c.kind === "announcements")!;
    expect((await call(olena, "POST", `/chats/${channel.id as string}/leave`)).status).toBe(
      400,
    );
    const direct = await call(olena, "POST", "/direct", { userId: iryna.id });
    expect((await call(olena, "POST", `/chats/${direct.body.id as string}/leave`)).status).toBe(
      400,
    );
  });
});

describe("the reader's own list", () => {
  it("mutes, pins and hides a chat for the reader alone", async () => {
    const chatId = await group(olena, "Settings", [petro]);
    const muted = await call(olena, "PUT", `/chats/${chatId}/settings`, {
      mute: "forever",
      pinned: true,
    });
    expect(muted.body.mutedUntil).toMatch(/^9999-/);
    expect(muted.body.pinnedAt).not.toBeNull();
    expect((await listOf(olena))[0].id).toBe(chatId);
    expect((await call(petro, "GET", `/chats/${chatId}`)).body.mutedUntil).toBeNull();

    await call(olena, "PUT", `/chats/${chatId}/settings`, { hidden: true, pinned: false });
    expect((await listOf(olena)).some((c) => c.id === chatId)).toBe(false);
    // something new arrives, and it is back
    await call(petro, "POST", `/chats/${chatId}/leave`);
    expect((await listOf(olena)).some((c) => c.id === chatId)).toBe(true);
  });

  it("keeps the channel on the list", async () => {
    const channel = (await listOf(olena)).find((c) => c.kind === "announcements")!;
    expect(
      (await call(olena, "PUT", `/chats/${channel.id as string}/settings`, { hidden: true }))
        .status,
    ).toBe(400);
  });
});

describe("a block (chat.md §11)", () => {
  it("takes the person out of every group and the channel, keeps their direct chats, and an unblock brings the channel back", async () => {
    const [kyrylo] = await createPeople(app, DOMAIN, ["Kyrylo"]);
    await listOf(kyrylo); // into the channel
    const owned = await group(kyrylo, "Kyrylo's", [petro, iryna]);
    await call(kyrylo, "PUT", `/chats/${owned}/members/${iryna.id}/role`, { role: "admin" });
    const other = await group(olena, "With Kyrylo", [kyrylo]);
    const direct = (await call(olena, "POST", "/direct", { userId: kyrylo.id })).body
      .id as string;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/users/${kyrylo.id}`,
      headers: { cookie: admin.cookie },
      payload: { status: "blocked" },
    });
    expect(res.statusCode).toBe(200);

    const membership = (chatId: string) =>
      prisma.chatMember.findUniqueOrThrow({
        where: { chatId_userId: { chatId, userId: kyrylo.id } },
      });
    expect((await membership(owned)).leftAt).not.toBeNull();
    expect((await membership(other)).leftAt).not.toBeNull();
    expect((await membership(direct)).leftAt).toBeNull();
    const channel = await prisma.chat.findUniqueOrThrow({
      where: { uniqueKey: "announcements" },
    });
    expect((await membership(channel.id)).leftAt).not.toBeNull();

    // the group reads "Kyrylo was blocked", and passes to its longest-standing admin
    const ownedNotices = await notices(owned);
    expect(ownedNotices.at(-2)).toMatchObject({
      notice: "member_blocked",
      noticeUserIds: [kyrylo.id],
      authorId: null,
    });
    const roles = Object.fromEntries(
      (await call(petro, "GET", `/chats/${owned}`)).body.members!.map((m) => [m.id, m.role]),
    );
    expect(roles[iryna.id]).toBe("owner");
    expect((await logged("chat_member.removed", kyrylo.id)).subjectLabel).toBe("Kyrylo Tester");

    await app.inject({
      method: "PATCH",
      url: `/api/users/${kyrylo.id}`,
      headers: { cookie: admin.cookie },
      payload: { status: "active" },
    });
    expect((await membership(channel.id)).leftAt).toBeNull();
    expect((await membership(owned)).leftAt).not.toBeNull();
  });
});

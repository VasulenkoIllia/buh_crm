import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../core/db.js";
import { sweepBounces } from "./mailouts.service.js";

const fixture = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`./bounce-fixtures/${name}.eml`, import.meta.url)),
    "utf8",
  );

/** A mailbox that replays real reports, so the suite needs no IMAP server. */
const mailboxOf = (files: string[]) => async (_: unknown, since: number | null) => ({
  uidValidity: "42",
  messages: files
    .map((f, i) => ({ uid: i + 1, source: fixture(f) }))
    .filter((m) => since === null || m.uid > since),
});

let accountId = "";
let clientId = "";

/** Each case starts from an unread mailbox; one of them tests the bookmark on purpose. */
async function freshMailbox() {
  await prisma.mailoutRecipient.deleteMany();
  await prisma.mailout.deleteMany();
  await prisma.deadEmailAddress.deleteMany();
  await prisma.mailSenderAccount.update({
    where: { id: accountId },
    data: { bounceLastUid: null, bounceUidValidity: null, bounceError: null },
  });
}

async function letterTo(email: string, messageId: string | null) {
  const mailout = await prisma.mailout.create({
    data: {
      subject: "Reminder",
      body: "Hi.",
      kind: "transactional",
      senderAccountId: accountId,
    },
  });
  return prisma.mailoutRecipient.create({
    data: {
      mailoutId: mailout.id,
      clientId,
      email,
      status: "sent",
      sentAt: new Date(Date.now() - 60_000),
      messageId,
    },
  });
}

/**
 * Take away only the client this file makes, and whatever has attached itself to it.
 *
 * It used to wipe every client in the test database, which worked until one of them had an invoice
 * — then `beforeAll` threw on `Invoice_clientId_fkey`, all six tests here were skipped, and the
 * file reported failed for reasons with nothing to do with bounces. A run interrupted halfway
 * leaves exactly that behind, so the cleanup has to be able to clear its own wreckage rather than
 * assume a pristine database (2026-08-28).
 */
async function forgetOurClient() {
  const ours = { email: "olena@example.com" };
  const client = await prisma.client.findFirst({ where: ours });
  if (!client) return;
  await prisma.invoice.deleteMany({ where: { clientId: client.id } });
  await prisma.client.deleteMany({ where: ours });
}

beforeAll(async () => {
  await prisma.mailoutRecipient.deleteMany();
  await prisma.mailout.deleteMany();
  await prisma.deadEmailAddress.deleteMany();
  await prisma.mailSenderAccount.deleteMany();
  await forgetOurClient();

  const account = await prisma.mailSenderAccount.create({
    data: {
      name: "Reminders",
      fromName: "ILLION",
      fromEmail: "sender@firm.example",
      imapHost: "mail.firm.example",
      imapPort: 993,
      imapSecure: true,
      isDefault: true,
    },
  });
  accountId = account.id;
  const client = await prisma.client.create({
    data: { firstName: "Olena", lastName: "Kovalenko", email: "olena@example.com" },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.mailoutRecipient.deleteMany();
  await prisma.mailout.deleteMany();
  await prisma.deadEmailAddress.deleteMany();
  await prisma.mailSenderAccount.deleteMany();
  await forgetOurClient();
});

describe("reading delivery reports back", () => {
  it("matches on the Message-ID the report quotes, and retires the address", async () => {
    await freshMailbox();
    const row = await letterTo(
      "nosuchuser@gmail.example",
      "<73bf8371-7cd2-da08-0c14-519d947063c9@firm.example>",
    );

    const [result] = await sweepBounces(mailboxOf(["gmail-550-5.1.1-no-such-user"]));
    expect(result.matched).toBe(1);
    expect(result.retired).toBe(1);

    const after = await prisma.mailoutRecipient.findUnique({ where: { id: row.id } });
    expect(after?.status).toBe("bounced");
    expect(after?.bounceKind).toBe("address");
    // The sentence names the fault, not the protocol: no reader wants "550 5.1.1".
    expect(after?.reason).toContain("This address does not exist");
    expect(after?.reason).not.toMatch(/^5\d\d/);

    const dead = await prisma.deadEmailAddress.findUnique({
      where: { email: "nosuchuser@gmail.example" },
    });
    expect(dead).not.toBeNull();
  });

  /**
   * The reports already sitting in the firm's mailbox predate letters carrying a key, so the
   * fallback is what makes them usable at all.
   */
  it("falls back to the address when no key is quoted", async () => {
    await freshMailbox();
    const row = await letterTo("bondarenko@yahoo.example", null);

    const [result] = await sweepBounces(mailboxOf(["yahoo-552-no-enhanced-code"]));
    expect(result.matched).toBe(1);
    const after = await prisma.mailoutRecipient.findUnique({ where: { id: row.id } });
    expect(after?.status).toBe("bounced");
    // Yahoo's bare `552` is a DEAD MAILBOX, not an oversized letter.
    expect(after?.bounceKind).toBe("address");
  });

  /**
   * The most damaging mistake this feature could make. ukr.net refused OUR relay's greeting and
   * named a real client in `Final-Recipient`. Retiring that address would blocklist a live client
   * over a setting on our own server.
   */
  it("records a refused greeting without retiring anybody's address", async () => {
    await freshMailbox();
    const row = await letterTo("o.ooooo@ukr.example", null);

    const [result] = await sweepBounces(mailboxOf(["ukrnet-554-5.3.0-helo"]));
    expect(result.matched).toBe(1);
    expect(result.retired).toBe(0);

    const after = await prisma.mailoutRecipient.findUnique({ where: { id: row.id } });
    expect(after?.bounceKind).toBe("system");
    expect(after?.reason).toContain("the address itself may be fine");
    expect(await prisma.deadEmailAddress.count()).toBe(0);
  });

  /** The bookmark is what stops a mailbox being re-read from the beginning every quarter hour. */
  it("resumes where it left off rather than rescanning", async () => {
    await freshMailbox();
    await letterTo("nosuchuser@gmail.example", null);

    const first = await sweepBounces(mailboxOf(["gmail-550-5.1.1-no-such-user"]));
    expect(first[0].read).toBe(1);
    const second = await sweepBounces(mailboxOf(["gmail-550-5.1.1-no-such-user"]));
    expect(second[0].read).toBe(0);

    const account = await prisma.mailSenderAccount.findUnique({ where: { id: accountId } });
    expect(account?.bounceLastUid).toBe(1);
    expect(account?.bounceCheckedAt).not.toBeNull();
  });

  /**
   * A block that cannot be lifted is a trap. The classification is an inference and can be wrong,
   * and a deleted mailbox can be recreated — so every retirement carries a way back.
   */
  it("lets a firm write to an address again, and re-blocks it on a later report", async () => {
    await freshMailbox();
    await letterTo("nosuchuser@gmail.example", null);
    await sweepBounces(mailboxOf(["gmail-550-5.1.1-no-such-user"]));
    expect(await prisma.deadEmailAddress.count({ where: { clearedAt: null } })).toBe(1);

    const user = await prisma.user.findFirst();
    await prisma.deadEmailAddress.update({
      where: { email: "nosuchuser@gmail.example" },
      data: { clearedAt: new Date(), clearedById: user?.id ?? null },
    });
    // Cleared rows are not returned to the send path, so the address is writable again.
    expect(await prisma.deadEmailAddress.count({ where: { clearedAt: null } })).toBe(0);

    // …and a fresh report retires it once more rather than leaving the vouching to stand.
    await prisma.mailSenderAccount.update({
      where: { id: accountId },
      data: { bounceLastUid: null, bounceUidValidity: null },
    });
    await sweepBounces(mailboxOf(["gmail-550-5.1.1-no-such-user"]));
    const again = await prisma.deadEmailAddress.findUnique({
      where: { email: "nosuchuser@gmail.example" },
    });
    expect(again?.clearedAt).toBeNull();
  });

  /** A mailbox that cannot be read must be visible as broken, not silently skipped. */
  it("records why a mailbox could not be read, and does not throw", async () => {
    const results = await sweepBounces(async () => {
      throw Object.assign(new Error("Command failed"), {
        responseText: "LOGIN failed. Invalid login/password",
        authenticationFailed: true,
      });
    });
    expect(results[0].error).toContain("username or password");

    const account = await prisma.mailSenderAccount.findUnique({ where: { id: accountId } });
    expect(account?.bounceError).toContain("username or password");
  });
});

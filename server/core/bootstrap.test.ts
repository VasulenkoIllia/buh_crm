import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./db.js";
import { ensureBaseData, ensureBootstrapAdmin } from "./bootstrap.js";
import { config } from "./config.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(async () => {
  await prisma.session.deleteMany();
  await prisma.authToken.deleteMany();
  await prisma.user.deleteMany();
  log.info.mockClear();
  log.warn.mockClear();
  log.error.mockClear();
});

describe("ensureBootstrapAdmin", () => {
  const creds = { email: "boss@firm.test", password: "supersecret", firstName: "Boss", lastName: "One" };

  it("creates the first admin when the users table is empty", async () => {
    const res = await ensureBootstrapAdmin(log, creds);
    expect(res.created).toBe(true);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: creds.email } });
    expect(user.role).toBe("admin");
    expect(user.status).toBe("active");
    expect(user.emailConfirmedAt).not.toBeNull();
    expect(user.passwordHash).toBeTruthy();
  });

  it("does nothing when a user already exists (never overwrites)", async () => {
    await ensureBootstrapAdmin(log, creds);
    const res = await ensureBootstrapAdmin(log, {
      ...creds,
      email: "someone-else@firm.test",
    });
    expect(res.created).toBe(false);
    expect(await prisma.user.count()).toBe(1);
    expect(
      await prisma.user.findUnique({ where: { email: "someone-else@firm.test" } }),
    ).toBeNull();
  });

  it("skips with a warning when credentials are missing", async () => {
    const res = await ensureBootstrapAdmin(log, { email: undefined, password: undefined });
    expect(res.created).toBe(false);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(await prisma.user.count()).toBe(0);
  });

  it("refuses a password shorter than 8 characters", async () => {
    const res = await ensureBootstrapAdmin(log, { ...creds, password: "short" });
    expect(res.created).toBe(false);
    expect(log.error).toHaveBeenCalledOnce();
    expect(await prisma.user.count()).toBe(0);
  });
});

describe("ensureBaseData — the default mailbox", () => {
  beforeEach(async () => {
    await prisma.mailoutRecipient.deleteMany();
    await prisma.mailout.deleteMany();
    await prisma.emailTemplate.deleteMany();
    await prisma.mailSenderAccount.deleteMany();
  });

  /**
   * Without this the Mailouts module is inert on day one: the first thing a new firm meets is
   * "No sender mailbox is set up", for an account the server already has and already uses.
   */
  it("gives a fresh install somewhere to send from", async () => {
    await ensureBaseData();

    const accounts = await prisma.mailSenderAccount.findMany();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].isDefault).toBe(true);
    // the address the server is actually entitled to send as — the one From that works untouched
    expect(accounts[0].fromEmail).toBe(config.MAIL_FROM);
    // NULL, not a copy of the env host: "borrow the .env account" has to keep meaning that when
    // the environment's SMTP details later change
    expect(accounts[0].smtpHost).toBeNull();
  });

  /** It is the firm's row from then on. A bootstrap that rewrote it would undo edits every deploy. */
  it("never touches a mailbox that already exists", async () => {
    await prisma.mailSenderAccount.create({
      data: { name: "Theirs", fromName: "Renamed", fromEmail: "them@example.com", isDefault: true },
    });

    await ensureBaseData();

    const accounts = await prisma.mailSenderAccount.findMany();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].name).toBe("Theirs");
    expect(accounts[0].fromEmail).toBe("them@example.com");
  });
});

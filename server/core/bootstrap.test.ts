import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./db.js";
import { ensureBootstrapAdmin } from "./bootstrap.js";

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

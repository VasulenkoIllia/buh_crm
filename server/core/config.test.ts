import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const baseEnv = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  SESSION_SECRET: "0123456789abcdef",
};

describe("loadConfig", () => {
  it("parses a minimal valid environment with defaults", () => {
    const config = loadConfig(baseEnv as NodeJS.ProcessEnv);
    expect(config.APP_NAME).toBe("buh_crm");
    expect(config.PORT).toBe(3000);
    expect(config.SMTP_SECURE).toBe(false);
  });

  it("coerces numbers and booleans from strings", () => {
    const config = loadConfig({
      ...baseEnv,
      PORT: "8080",
      SMTP_SECURE: "true",
    } as NodeJS.ProcessEnv);
    expect(config.PORT).toBe(8080);
    expect(config.SMTP_SECURE).toBe(true);
  });

  it("rejects a missing DATABASE_URL", () => {
    expect(() =>
      loadConfig({ SESSION_SECRET: baseEnv.SESSION_SECRET } as NodeJS.ProcessEnv),
    ).toThrow(/DATABASE_URL/);
  });

  it("rejects a short SESSION_SECRET", () => {
    expect(() =>
      loadConfig({ ...baseEnv, SESSION_SECRET: "short" } as NodeJS.ProcessEnv),
    ).toThrow(/SESSION_SECRET/);
  });
});

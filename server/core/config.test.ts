import { describe, expect, it } from "vitest";
import { loadConfig, strayBackupVariables } from "./config.js";

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

describe("loadConfig: where files go", () => {
  const bucket = {
    FILES_S3_ENDPOINT: "https://fsn1.your-objectstorage.com",
    FILES_S3_REGION: "fsn1",
    FILES_S3_BUCKET: "a-files-bucket",
    FILES_S3_ACCESS_KEY_ID: "access",
    FILES_S3_SECRET_ACCESS_KEY: "secret",
  };

  it("stores new files locally unless told otherwise", () => {
    expect(loadConfig(baseEnv as NodeJS.ProcessEnv).FILES_STORAGE).toBe("local");
  });

  it("refuses the bucket without its settings", () => {
    expect(() => loadConfig({ ...baseEnv, FILES_STORAGE: "s3" } as NodeJS.ProcessEnv)).toThrow(
      /FILES_S3_BUCKET: required when FILES_STORAGE=s3/,
    );
  });

  it("refuses the bucket without SECRETS_KEY, which every file is encrypted with", () => {
    expect(() =>
      loadConfig({ ...baseEnv, FILES_STORAGE: "s3", ...bucket } as NodeJS.ProcessEnv),
    ).toThrow(/SECRETS_KEY: required when FILES_STORAGE=s3/);
  });

  it("accepts the bucket with everything it needs", () => {
    const config = loadConfig({
      ...baseEnv,
      FILES_STORAGE: "s3",
      ...bucket,
      SECRETS_KEY: "a-key",
    } as NodeJS.ProcessEnv);
    expect(config.FILES_STORAGE).toBe("s3");
    expect(config.FILES_S3_FORCE_PATH_STYLE).toBe(false);
  });

  it("takes a blank FILES_S3_ENDPOINT as unset, so an empty line in .env cannot stop a server", () => {
    const config = loadConfig({ ...baseEnv, FILES_S3_ENDPOINT: "" } as NodeJS.ProcessEnv);
    expect(config.FILES_STORAGE).toBe("local");
  });

  it("refuses a bucket endpoint that is not a URL", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        FILES_STORAGE: "s3",
        ...bucket,
        FILES_S3_ENDPOINT: "fsn1",
        SECRETS_KEY: "a-key",
      } as NodeJS.ProcessEnv),
    ).toThrow(/FILES_S3_ENDPOINT: must be a URL/);
  });
});

describe("strayBackupVariables", () => {
  it("names the backup's credentials and nothing of the app's own", () => {
    expect(
      strayBackupVariables({
        AWS_ACCESS_KEY_ID: "x",
        RESTIC_PASSWORD_FILE: "x",
        RCLONE_CONFIG_FILESSRC_TYPE: "s3",
        B2_ACCOUNT_ID: "x",
        FILES_S3_ACCESS_KEY_ID: "x",
        SECRETS_KEY: "x",
        PATH: "/bin",
      }),
    ).toEqual([
      "AWS_ACCESS_KEY_ID",
      "B2_ACCOUNT_ID",
      "RCLONE_CONFIG_FILESSRC_TYPE",
      "RESTIC_PASSWORD_FILE",
    ]);
  });
});

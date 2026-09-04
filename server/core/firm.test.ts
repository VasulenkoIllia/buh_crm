import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "./config.js";

/** Each case needs a COLD cache, and the cache is module state. */
async function freshFirm() {
  vi.resetModules();
  return import("./firm.js");
}

describe("the firm name letters print", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("prints what the firm typed into Settings", async () => {
    const { loadFirmName, firmName } = await freshFirm();
    await loadFirmName(async () => "  ILLION Tax & Accounting  ");
    expect(firmName()).toBe("ILLION Tax & Accounting");
  });

  /**
   * The whole point of the module: APP_NAME is the container's technical id, and a client must
   * never read it in a masthead (user, 2026-08-31). It is the fallback of last resort only.
   */
  it("says so loudly when it cannot read the name, instead of failing silently", async () => {
    const { loadFirmName, firmName } = await freshFirm();
    await loadFirmName(async () => {
      throw new Error("connection terminated");
    });
    expect(console.error).toHaveBeenCalled();
    expect(firmName()).toBe(config.APP_NAME); // the fallback, and now a visible one
  });

  /**
   * A transient failure at boot used to last the life of the process: nothing retried, and Settings
   * reads the name straight from the database, so the screen looked right while every letter went
   * out wrong. A cold cache now asks again in the background.
   */
  it("asks again after a failure, so the fallback lasts one letter and not until the next deploy", async () => {
    const { loadFirmName, firmName } = await freshFirm();
    let attempt = 0;
    const flaky = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("connection terminated");
      return "Kvitka Trade Advisors";
    };

    await loadFirmName(flaky);
    expect(firmName()).toBe(config.APP_NAME); // first letter still carries the fallback
    await vi.waitFor(() => expect(attempt).toBe(2)); // …and the retry it kicked off lands
    expect(firmName()).toBe("Kvitka Trade Advisors");
  });

  it("does not queue a read per letter while one is already in flight", async () => {
    const { loadFirmName, firmName } = await freshFirm();
    let attempt = 0;
    await loadFirmName(async () => {
      attempt += 1;
      throw new Error("still down");
    });
    expect(attempt).toBe(1);
    firmName();
    firmName();
    firmName();
    await vi.waitFor(() => expect(attempt).toBe(2)); // one retry, not three
  });

  it("follows a rename without waiting for a reload", async () => {
    const { loadFirmName, rememberFirmName, firmName } = await freshFirm();
    await loadFirmName(async () => "Old Name");
    rememberFirmName("New Name");
    expect(firmName()).toBe("New Name");
    rememberFirmName("   "); // a blank rename is not a name
    expect(firmName()).toBe("New Name");
  });
});

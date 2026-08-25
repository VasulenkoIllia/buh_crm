import { describe, expect, it } from "vitest";
import { imapAuth } from "./imap.js";

/**
 * The gap this closes: the rule lived inside `imapFor`, which only runs against a live mailbox.
 * Changing it — say, to ignore the mailbox's own password — broke nothing in the suite, because
 * nothing in the suite could reach it.
 */
describe("which credentials read a mailbox", () => {
  it("reuses the SMTP pair when the mailbox has no username of its own", () => {
    expect(imapAuth({ imapUser: null, smtpUser: "info@firm.example" })).toEqual({
      user: "info@firm.example",
      ownPassword: false,
    });
  });

  it("uses its own pair when it has one", () => {
    expect(
      imapAuth({ imapUser: "reminder@firm.example", smtpUser: "info@firm.example" }),
    ).toEqual({
      user: "reminder@firm.example",
      ownPassword: true,
    });
  });

  /** Whitespace is not a username; treating it as one would authenticate as nobody. */
  it("treats a blank username as none at all", () => {
    expect(imapAuth({ imapUser: "   ", smtpUser: "info@firm.example" })).toEqual({
      user: "info@firm.example",
      ownPassword: false,
    });
  });

  /**
   * The pairing is the point: never this username with that password. A mailbox with its own
   * username must never fall back to the SMTP password, and one without must never use an IMAP
   * password left behind by an earlier save.
   */
  it("never mixes one side's username with the other's password", () => {
    expect(imapAuth({ imapUser: "own@firm.example", smtpUser: null }).ownPassword).toBe(true);
    expect(imapAuth({ imapUser: null, smtpUser: null })).toEqual({
      user: null,
      ownPassword: false,
    });
  });
});

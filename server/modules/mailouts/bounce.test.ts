import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classify, isDeliveryReport, parseBounce } from "./bounce.js";

const fixture = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`./bounce-fixtures/${name}.eml`, import.meta.url)),
    "utf8",
  );

/**
 * Six real reports, because an invented one agrees with whatever rule was invented beside it.
 * Every expectation here was read off a production bounce, not imagined.
 */
describe("reading a real delivery report", () => {
  it("recognises one, and passes ordinary mail by", () => {
    expect(isDeliveryReport(fixture("gmail-550-5.1.1-no-such-user"))).toBe(true);
    expect(isDeliveryReport("From: olena@example.com\nSubject: hello\n\nhi")).toBe(false);
  });

  it("reads Google's refusal at RCPT TO", () => {
    const b = parseBounce(fixture("gmail-550-5.1.1-no-such-user"))!;
    expect(b.email).toBe("nosuchuser@gmail.example");
    expect(b.kind).toBe("address");
    expect(b.code).toBe("5.1.1");
    expect(b.stage).toBe("RCPT TO");
    expect(b.reason).toContain("does not exist");
    // The folded diagnostic repeats "550-5.1.1" on every line; unfolded verbatim it is gibberish.
    expect(b.reason).not.toMatch(/550-5\.1\.1.*550-5\.1\.1/);
    expect(b.reason).not.toContain("http");
  });

  /**
   * The fixture that rewrote the rules. Yahoo reports a DEAD MAILBOX as bare `552` — the code an
   * earlier draft assigned to "message too large" — with no enhanced code anywhere. Classifying on
   * the number would have filed it under `letter`, so the address was never retired and the firm
   * went on writing to it.
   */
  it("believes Yahoo's words over Yahoo's number", () => {
    const b = parseBounce(fixture("yahoo-552-no-enhanced-code"))!;
    expect(b.email).toBe("bondarenko@yahoo.example");
    expect(b.kind).toBe("address");
    expect(b.code).toBe("552");
    expect(b.stage).toBe("end of data");
  });

  /**
   * The opposite mistake, and the more damaging one: ukr.net refused our relay's greeting, and the
   * report names a real client in `Final-Recipient:`. Blaming the address would blacklist a live
   * client over a setting on our own server.
   */
  it("blames the mail system, not the address, for a refused greeting", () => {
    const b = parseBounce(fixture("ukrnet-554-5.3.0-helo"))!;
    expect(b.kind).toBe("system");
    expect(b.code).toBe("5.3.0");
    expect(b.stage).toBe("HELO");
  });

  it("takes the join key out of References", () => {
    for (const name of [
      "gmail-550-5.1.1-no-such-user",
      "gmail-550-5.1.1-repeat",
      "google-550-5.1.1-no-such-user",
      "yahoo-552-no-enhanced-code",
      "ukrnet-554-5.3.0-helo",
      "ukrnet-554-5.3.0-helo-repeat",
    ]) {
      const b = parseBounce(fixture(name))!;
      expect(b, name).not.toBeNull();
      expect(b.messageId, name).toMatch(/^<.+@.+>$/);
      expect(b.email, name).toContain("@");
    }
  });
});

describe("what a diagnostic means", () => {
  it("never retires an address over a transient failure", () => {
    expect(classify("451 4.7.1 Greylisted, try again later").kind).toBe("transient");
    expect(classify("421 4.3.2 Service not available").kind).toBe("transient");
  });

  /** A full mailbox EXISTS. Retiring it loses a client over a week of holiday photographs. */
  it("does not retire a mailbox that is merely full", () => {
    expect(classify("552 5.2.2 Mailbox full").kind).toBe("system");
    expect(classify("452 4.2.2 over quota").kind).toBe("transient");
  });

  it("retires a mailbox that is gone, whatever the number", () => {
    for (const text of [
      "550 5.1.1 User unknown",
      "552 1 Requested mail action aborted, mailbox not found",
      "550 Recipient address rejected: User unknown in virtual mailbox table",
      "553 no such user here",
    ]) {
      expect(classify(text).kind, text).toBe("address");
    }
  });

  it("keeps our own mail system's failures away from the address", () => {
    expect(classify("554 5.3.0 Invalid parameters of HELO").kind).toBe("system");
    expect(classify("550 5.7.1 Sender address rejected").kind).toBe("system");
  });

  /**
   * The case the wording rules exist for, and the only one the codes cannot save.
   *
   * A server refusing to verify OUR sender often answers in the ADDRESSING class — `5.1.x` — while
   * the failure is entirely about us. Trusting the code would retire a live client's mailbox over
   * our own configuration, which is the most damaging mistake this module can make.
   */
  it("does not retire a recipient when the SENDER is what was refused", () => {
    expect(classify("550 5.1.1 Sender verify failed").kind).toBe("system");
    expect(classify("550 5.1.0 Sender address rejected: not owned by user").kind).toBe(
      "system",
    );
    expect(classify("550 5.1.8 Sender address rejected: Domain not found").kind).toBe("system");
  });

  it("knows an oversized letter from a dead mailbox", () => {
    expect(classify("552 5.3.4 Message size exceeds fixed limit").kind).toBe("letter");
  });
});

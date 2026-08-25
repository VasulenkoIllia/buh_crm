import { describe, expect, it } from "vitest";
import { explainSendError } from "./send-error.js";

/** Build the error shape nodemailer actually throws, with only the fields a case cares about. */
function smtpError(message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), extra);
}

/**
 * The gap this closes: raw protocol text was being shown to the person who has to fix it.
 *
 * `getaddrinfo ENOTFOUND smtp.exmaple.com` beside a client's name says nothing a bookkeeper can
 * act on — and worse, it does not say WHOSE problem it is. Every case below asserts the `fault`,
 * because that is the field that decides which screen the reader should open.
 */
describe("explaining a failed send", () => {
  it("blames the firm's own settings for a rejected login", () => {
    const out = explainSendError(
      smtpError("Invalid login: 535 5.7.8 Error: authentication failed", {
        code: "EAUTH",
        responseCode: 535,
      }),
    );
    expect(out.fault).toBe("settings");
    expect(out.message).toContain("username or password");
    expect(out.message).not.toContain("535");
    expect(out.retryable).toBe(false);
  });

  it("names the unreachable host, taking it from the error when context has none", () => {
    const out = explainSendError(
      smtpError("getaddrinfo ENOTFOUND smtp.exmaple.com", { code: "ENOTFOUND" }),
    );
    expect(out.fault).toBe("settings");
    expect(out.message).toContain("smtp.exmaple.com");
  });

  it("prefers the caller's host and port over parsing the message", () => {
    const out = explainSendError(
      smtpError("connect ECONNREFUSED 1.2.3.4:465", {
        code: "ECONNREFUSED",
      }),
      { host: "mail.illion.example", port: 465 },
    );
    expect(out.message).toContain("mail.illion.example:465");
    expect(out.fault).toBe("settings");
  });

  /** The most common real misconfiguration in this app, and the least legible raw. */
  it("translates an SSL/port mismatch into the actual fix", () => {
    const out = explainSendError(
      smtpError("140234:error:1408F10B:SSL routines:ssl3_get_record:wrong version number"),
    );
    expect(out.fault).toBe("settings");
    expect(out.message).toContain("465");
    expect(out.message).toContain("587");
  });

  it("blames the address for a refusal at RCPT TO, and will not retry it", () => {
    const out = explainSendError(
      smtpError("Message failed", {
        code: "EENVELOPE",
        command: "RCPT TO",
        responseCode: 550,
        response: "550 5.1.1 <petro@examle.com>: Recipient address rejected: User unknown",
      }),
    );
    expect(out.fault).toBe("address");
    expect(out.message).toContain("User unknown");
    expect(out.retryable).toBe(false);
  });

  /** Both arrive as 5xx, but the sender case is fixed in a different screen entirely. */
  it("separates a rejected From from a rejected recipient", () => {
    const out = explainSendError(
      smtpError("Mail command failed", {
        command: "MAIL FROM",
        responseCode: 553,
        response: "553 5.7.1 Sender address rejected: not owned by user",
      }),
    );
    expect(out.fault).toBe("settings");
    expect(out.message).toContain("send as that From address");
  });

  it("passes our own RCPT refusal through untouched — it is already a sentence", () => {
    const raw = "The mail server refused ghost@nowhere.example — 550 5.1.1 no such user";
    const out = explainSendError(new Error(raw));
    expect(out.message).toBe(raw);
    expect(out.fault).toBe("address");
    expect(out.retryable).toBe(false);
  });

  it("calls a 4xx temporary, says the address is fine, and allows a retry", () => {
    const out = explainSendError(
      smtpError("Message failed", {
        responseCode: 451,
        response: "451 4.7.1 Greylisted, try again later",
      }),
    );
    expect(out.fault).toBe("temporary");
    expect(out.message).toContain("nothing is wrong");
    expect(out.retryable).toBe(true);
  });

  /**
   * The regression these two lock down: nodemailer labels the SYMPTOM, not the severity. A busy
   * server answering `421` at greeting arrives as `ECONNECTION`, and a temporary auth failure as
   * `EAUTH` — so reading the code before the number sent people to re-check a host that was fine
   * and to retype a password that was correct, and refused the retry that would have worked.
   */
  it("calls a 421 at connect temporary, not a broken host", () => {
    const out = explainSendError(
      smtpError("Connection closed", {
        code: "ECONNECTION",
        responseCode: 421,
        response: "421 4.7.0 Too many connections, try later",
      }),
    );
    expect(out.fault).toBe("temporary");
    expect(out.retryable).toBe(true);
    expect(out.message).not.toMatch(/check the host|SSL setting/);
  });

  it("calls a 454 temporary auth failure temporary, not a wrong password", () => {
    const out = explainSendError(
      smtpError("Invalid login", {
        code: "EAUTH",
        responseCode: 454,
        response: "454 4.7.0 Temporary authentication failure",
      }),
    );
    expect(out.fault).toBe("temporary");
    expect(out.retryable).toBe(true);
    expect(out.message).not.toMatch(/username or password/);
  });

  /**
   * The regression: the SSL hint named 465/587 for every protocol. Somebody configuring the
   * mailbox READER would be sent to check a submission port that is not on the screen they are
   * looking at — worse than saying nothing, because it reads as a specific instruction.
   */
  it("names IMAP ports when the failure was an IMAP one", () => {
    const tls = smtpError("wrong version number, SSL routines");
    expect(explainSendError(tls, { protocol: "imap" }).message).toContain("993");
    expect(explainSendError(tls, { protocol: "imap" }).message).not.toContain("587");
    expect(explainSendError(tls).message).toContain("587");
  });

  /**
   * Found by running the real button, not by reading the code: an unreachable IMAP host was
   * answered with "check the SMTP host", which is a different field on the same screen.
   */
  it("names the IMAP host field when an IMAP host cannot be found", () => {
    const gone = smtpError("getaddrinfo ENOTFOUND imap.dev.invalid", { code: "ENOTFOUND" });
    expect(explainSendError(gone, { protocol: "imap" }).message).toContain("IMAP host");
    expect(explainSendError(gone, { protocol: "imap" }).message).not.toContain("SMTP");
    expect(explainSendError(gone).message).toContain("SMTP host");
  });

  it("says which credentials were refused when the mailbox is being read", () => {
    const auth = smtpError("Invalid login", { code: "EAUTH", responseCode: 535 });
    expect(explainSendError(auth, { protocol: "imap" }).message).toContain("IMAP credentials");
    expect(explainSendError(auth).message).not.toContain("IMAP");
  });

  it("never opens a sentence in lower case when no host is known", () => {
    const out = explainSendError(smtpError("connect ECONNREFUSED", { code: "ECONNREFUSED" }));
    expect(out.message[0]).toBe(out.message[0].toUpperCase());
  });

  it("recognises an oversized letter as the letter's fault, not the address's", () => {
    const out = explainSendError(
      smtpError("Message failed", {
        responseCode: 552,
        response: "552 5.3.4 Message size exceeds fixed maximum message size",
      }),
    );
    expect(out.fault).toBe("letter");
  });

  /** Hiding an unrecognised failure behind a vague sentence would lose the only clue there is. */
  it("passes an unrecognised error through rather than swallowing it", () => {
    const out = explainSendError(new Error("something nobody has seen before"));
    expect(out.fault).toBe("unknown");
    expect(out.message).toBe("something nobody has seen before");
  });

  it("survives being handed something that is not an Error", () => {
    expect(explainSendError(undefined).message).toBe("The letter could not be sent.");
    expect(explainSendError("plain string").message).toBe("plain string");
    expect(explainSendError(null).fault).toBe("unknown");
  });
});

import { describe, expect, it } from "vitest";
import { refusalOf } from "./email.js";

/**
 * The gap this closes: a resolved `sendMail` was being read as "sent".
 *
 * When the receiving server refuses an address at `RCPT TO` — what a real server answers for a
 * mailbox that does not exist on a domain it is authoritative for — nodemailer resolves rather
 * than throwing, and names the address in `rejected`. The result was discarded, so the delivery
 * log said `sent` about a letter the server had just declined to take: wrong, and confident.
 */
describe("what the mail server refused", () => {
  it("says nothing when every address was taken", () => {
    expect(refusalOf({ accepted: ["a@b.com"], rejected: [] } as never)).toBeNull();
    expect(refusalOf({})).toBeNull();
  });

  it("names the address and quotes the server", () => {
    const said = refusalOf({
      rejected: ["ghost@nowhere.example"],
      rejectedErrors: [{ message: "550 5.1.1 <ghost@nowhere.example>: no such user" }],
    });
    expect(said).toContain("ghost@nowhere.example");
    expect(said).toContain("550 5.1.1");
  });

  it("falls back to the raw response when there is no per-address error", () => {
    expect(refusalOf({ rejected: ["x@y.z"], response: "550 mailbox unavailable" })).toBe(
      "The mail server refused x@y.z — 550 mailbox unavailable",
    );
  });

  /** nodemailer reports addresses as strings or as objects depending on the transport. */
  it("reads either shape nodemailer reports", () => {
    expect(refusalOf({ rejected: [{ address: "obj@form.example" }] })).toContain("obj@form.example");
  });

  it("still refuses when the server explained nothing", () => {
    expect(refusalOf({ rejected: ["quiet@example.com"] })).toBe(
      "The mail server refused quiet@example.com",
    );
  });
});

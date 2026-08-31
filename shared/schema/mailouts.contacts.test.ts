import { describe, expect, it } from "vitest";
import { CONTACT_ORDER, MAX_CONTACT_PILLS, contactsInLetter } from "./mailouts.js";

/**
 * The order and the cap have TWO readers now — `contactLinks` builds the buttons from them and the
 * mailbox form tells a firm which buttons its letters will carry. They used to be implicit in a
 * sequence of `if`s, which is why the form could only describe the rule by repeating it
 * (2026-08-31).
 */
describe("which contacts become buttons", () => {
  it("keeps only what is filled in, in the letter's order", () => {
    expect(contactsInLetter({ website: "illion.tax", email: "info@illion.tax" })).toEqual([
      "email",
      "website",
    ]);
    expect(contactsInLetter({})).toEqual([]);
    expect(contactsInLetter({ phone: "   ", email: null })).toEqual([]);
  });

  /** The real shape of this firm's mailbox: five filled, and the website is the one that goes. */
  it("drops the website first when more are filled than fit", () => {
    const kept = contactsInLetter({
      email: "info@illion.tax",
      phone: "+1 (704) 726-6994",
      telegram: "+1 (704) 726-6994",
      whatsapp: "+1 (704) 726-6994",
      website: "illion.tax",
    });
    expect(kept).toEqual(["email", "phone", "telegram", "whatsapp"]);
    expect(kept).not.toContain("website");
  });

  it("never returns more than fit across a letter", () => {
    const all = Object.fromEntries(CONTACT_ORDER.map((k) => [k, "x"]));
    expect(contactsInLetter(all)).toHaveLength(MAX_CONTACT_PILLS);
  });

  /** With room to spare, nothing is dropped — the cap is a ceiling, not a quota. */
  it("keeps every filled field when they fit", () => {
    expect(contactsInLetter({ email: "a@b.c", phone: "1", telegram: "@x" })).toEqual([
      "email",
      "phone",
      "telegram",
    ]);
  });
});

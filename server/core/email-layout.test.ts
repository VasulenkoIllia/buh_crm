import { describe, expect, it } from "vitest";
import { contactLinks, renderLetter, renderLetterText } from "./email-layout.js";

const ILLION_SIGNATURE = `Maryna Onyshchenko, EA, MBA
Accountant | Tax & Accounting Services
ILLION — tax & accounting
illion.tax
info@illion.tax
+1 (704) 726-6994
Telegram / WhatsApp: +1 (704) 726-6994`;

const shell = {
  heading: "Your Kvitka Trade LLC filing is due",
  body: "Dear Olena,\n\nThe quarterly filing is due at the end of the month.",
  firmName: "ILLION Tax & Accounting",
  signature: ILLION_SIGNATURE,
  postalAddress: "1200 Main St, Suite 4, Charlotte, NC 28202, USA",
  unsubscribeUrl: "https://buhcrm.workflo.space/api/mailouts/unsubscribe/TOKEN",
  logoSrc: null,
  contacts: {
    email: "info@illion.tax",
    phone: "+1 (704) 726-6994",
    telegram: "+1 (704) 726-6994",
    whatsapp: "+1 (704) 726-6994",
    website: "illion.tax",
  },
  // a mailout is written in a textarea and has neither — both belong to transactional letters
  cta: null,
  facts: [],
};

describe("contactLinks", () => {
  /**
   * These used to be parsed out of the signature, which meant guessing whether a line was a
   * Telegram number or a plain call. A field is either filled or it is not.
   */
  it("makes one button per filled field, and none for the empty ones", () => {
    const links = contactLinks({ email: "info@illion.tax", phone: "+1 (704) 726-6994" });
    expect(links.map((l) => l.label)).toEqual(["Email", "Call"]);
    expect(links[0].href).toBe("mailto:info@illion.tax");
    expect(links[1].href).toBe("tel:+17047266994");
  });

  it("returns nothing when nothing is filled in", () => {
    expect(contactLinks({})).toEqual([]);
    expect(contactLinks({ email: "  ", phone: null })).toEqual([]);
  });

  /** `wa.me`, `t.me` and viber:// all reject anything but digits. */
  it("strips the punctuation people really type around a number", () => {
    for (const written of ["+1 (704) 726-6994", "1.704.726.6994", "+1-704-726-6994"]) {
      expect(contactLinks({ phone: written })[0].href, written).toBe("tel:+17047266994");
      expect(contactLinks({ whatsapp: written })[0].href, written).toBe("https://wa.me/17047266994");
    }
  });

  /** Telegram is the one channel where people have either a handle or a number. */
  it("takes a Telegram @username or a phone, and uses the right URL for each", () => {
    expect(contactLinks({ telegram: "@illion_tax" })[0].href).toBe("https://t.me/illion_tax");
    expect(contactLinks({ telegram: "illion_tax" })[0].href).toBe("https://t.me/illion_tax");
    expect(contactLinks({ telegram: "+1 (704) 726-6994" })[0].href).toBe("https://t.me/+17047266994");
  });

  it("builds a Viber deep link", () => {
    expect(contactLinks({ viber: "+1 (704) 726-6994" })[0].href).toBe(
      "viber://chat?number=%2B17047266994",
    );
  });

  it("adds https:// to a bare domain, and leaves a full URL alone", () => {
    expect(contactLinks({ website: "illion.tax" })[0].href).toBe("https://illion.tax");
    expect(contactLinks({ website: "https://illion.tax/en" })[0].href).toBe("https://illion.tax/en");
  });

  /**
   * Five pills overflow a 600px letter, and a wrapped row of table cells does not reflow in
   * Outlook — it runs off the edge. The website is dropped first: it is already a link inside the
   * signature card just above.
   */
  it("caps the row at four, in a fixed order", () => {
    const links = contactLinks({
      email: "a@b.co",
      phone: "1234567890",
      telegram: "@x",
      whatsapp: "1234567890",
      viber: "1234567890",
      website: "illion.tax",
    });
    expect(links.map((l) => l.label)).toEqual(["Email", "Call", "Telegram", "WhatsApp"]);
  });
});

describe("renderLetter", () => {
  it("carries the brand: green, the wordmark lockup and the closing band", () => {
    const html = renderLetter(shell);
    expect(html).toContain("#37544F");
    expect(html).toContain("ILLION");
    expect(html).toContain("TAX &amp; ACCOUNTING");
  });

  it("puts the contact pills in, pointing at real schemes", () => {
    const html = renderLetter(shell);
    expect(html).toContain("mailto:info@illion.tax");
    expect(html).toContain("tel:+17047266994");
    expect(html).toContain("https://t.me/+17047266994");
    expect(html).toContain("https://wa.me/17047266994");
  });

  /** A client's own name goes through here. `Smith & Sons <Holdings>` must not become markup. */
  it("escapes everything a client could influence", () => {
    const html = renderLetter({
      ...shell,
      heading: "<script>alert(1)</script>",
      body: "Dear <b>bold</b> & co",
      firmName: "A & B <Ltd>",
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&amp;");
  });

  it("omits the legal footer on a transactional letter but still closes on the brand", () => {
    const html = renderLetter({ ...shell, postalAddress: null, unsubscribeUrl: null });
    expect(html).not.toContain("Charlotte");
    expect(html).not.toContain("Unsubscribe");
    expect(html).toContain("#37544F");
  });

  /** The rule under the firm name separates it from the legal lines. With none, it is just a
   *  dangling line across an empty band. */
  it("draws no divider in the closing band when there is nothing below it", () => {
    const withLegal = renderLetter(shell);
    const without = renderLetter({ ...shell, postalAddress: null, unsubscribeUrl: null });
    expect(withLegal).toContain("border-top:1px solid #2b423e");
    expect(without).not.toContain("border-top:1px solid #2b423e");
  });

  /**
   * A fixed pixel width does not shrink, and clips every line on a phone. This is a regression
   * pin: the first version shipped with `width="600"` and lost its right-hand edge.
   */
  it("stays fluid rather than pinning a pixel width", () => {
    const html = renderLetter(shell);
    expect(html).toContain("max-width:600px");
    expect(html).not.toContain('width="600"');
  });

  /** The preview and the send need different sources; a hard-coded `cid:` broke every preview. */
  it("draws whatever source it is handed, and the wordmark when handed none", () => {
    expect(renderLetter({ ...shell, logoSrc: "cid:firm-logo" })).toContain('src="cid:firm-logo"');
    expect(renderLetter({ ...shell, logoSrc: "data:image/png;base64,AAA" })).toContain(
      'src="data:image/png;base64,AAA"',
    );
    const none = renderLetter(shell);
    expect(none).not.toContain("<img");
    expect(none).toContain("TAX &amp; ACCOUNTING"); // the wordmark, set in type
  });

  it("uses no technique Outlook or Gmail would drop", () => {
    const html = renderLetter(shell);
    for (const banned of ["display:flex", "display:grid", "<style", "background-image", "<svg"]) {
      expect(html, banned).not.toContain(banned);
    }
  });
});

describe("renderLetterText", () => {
  it("says everything the HTML does, for clients that show only text", () => {
    const text = renderLetterText(shell);
    expect(text).toContain(shell.heading);
    expect(text).toContain("Maryna Onyshchenko");
    expect(text).toContain("Charlotte");
    expect(text).toContain(shell.unsubscribeUrl);
    expect(text).not.toContain("<");
  });
});

/**
 * The two blocks a TRANSACTIONAL letter uses where a mailout puts its signature and buttons.
 *
 * They exist because `body` is escaped plain text — a link cannot be written into it — and every
 * system letter this app sends has the same shape: a sentence, a link, a caveat (user, 2026-08-31).
 */
describe("the transactional blocks", () => {
  const transactional = {
    ...shell,
    heading: "Reset your password",
    body: "Someone asked to reset the password for your account.",
    signature: null,
    contacts: {},
    postalAddress: null,
    unsubscribeUrl: null,
    facts: [{ label: "Account", value: "illia@illion.tax" }],
    cta: { label: "Set a new password", url: "https://buhcrm.workflo.space/reset?token=ABC&x=1" },
  };

  it("draws the button as a table, not a padded link", () => {
    const html = renderLetter(transactional);
    // Outlook ignores padding on inline elements, so an <a> alone degrades to underlined text
    // at the exact moment it matters most
    expect(html).toContain("Set a new password");
    expect(html).toMatch(/<table[^>]*>\s*<tr><td style="border-radius:10px;background:/);
  });

  /**
   * `&amp;` in an attribute IS the ampersand — clients decode it — so escaping the href costs the
   * query string nothing and stops a URL built from user input ever breaking out of the attribute.
   * The contact pills have always escaped theirs; this used not to, which was the audit's find.
   */
  it("escapes the href and the label, and the query string still means what it says", () => {
    const html = renderLetter({
      ...transactional,
      cta: { label: "Open <the> task", url: "https://x.test/a?b=1&c=2" },
    });
    expect(html).toContain('href="https://x.test/a?b=1&amp;c=2"');
    expect(html).toContain("Open &lt;the&gt; task");
    expect(html).not.toContain('href="https://x.test/a?b=1&c=2"');
  });

  it("cannot be broken out of by a url carrying a quote", () => {
    const html = renderLetter({
      ...transactional,
      cta: { label: "Go", url: 'https://x.test/"><script>alert(1)</script>' },
    });
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("prints the facts as label and value, both escaped", () => {
    const html = renderLetter({
      ...transactional,
      facts: [{ label: "Client", value: "Smith & Sons <Holdings>" }],
    });
    expect(html).toContain("Client");
    expect(html).toContain("Smith &amp; Sons &lt;Holdings&gt;");
  });

  /** The combination nothing sends yet: a notification with facts and nothing to click. */
  it("still leaves room above the footer when there are facts but no button", () => {
    const html = renderLetter({ ...transactional, cta: null });
    expect(html).toContain("illia@illion.tax");
    expect(html).toContain("height:24px");
  });

  it("draws nothing at all when there is neither", () => {
    const html = renderLetter({ ...transactional, cta: null, facts: [] });
    expect(html).not.toContain("border-radius:10px;background:");
    // the VALUE, not the label "Account" — the firm is called "Tax & Accounting"
    expect(html).not.toContain("illia@illion.tax");
    // …and no gap under a group that isn't there
    expect(html).not.toContain("height:24px");
  });

  /** The exemption the shell was always written for, finally exercised. */
  it("carries no postal address and no unsubscribe", () => {
    const html = renderLetter(transactional);
    expect(html).not.toContain("1200 Main St");
    expect(html).not.toMatch(/unsubscribe/i);
  });

  /**
   * The text part is not decoration: a message without one scores worse with spam filters, and it
   * is the only version some clients show. A reader who sees only this must still be able to
   * finish what the letter asks — so the URL is spelled out, not the label alone.
   */
  it("spells the URL out in the text half, with the facts", () => {
    const text = renderLetterText(transactional);
    expect(text).toContain("Account: illia@illion.tax");
    expect(text).toContain(
      "Set a new password: https://buhcrm.workflo.space/reset?token=ABC&x=1",
    );
    expect(text).not.toMatch(/unsubscribe/i);
  });
});

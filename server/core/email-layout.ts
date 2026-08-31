/**
 * The brand shell every mailout is poured into.
 *
 * The firm's requirement was "однаково з вигляду, а ми змінюємо заголовок і тему" — so the shell
 * is NOT editable from the template editor. A template supplies a subject, a heading and a body;
 * everything around them is generated here, identically, every time. That is also what keeps the
 * letters recognisable to spam filters as a consistent sender rather than a stream of one-off HTML.
 *
 * ## The design is taken from illion.tax, not invented
 *
 * Every value below was read off the live site (2026-08-11) rather than guessed, because a letter
 * that is *almost* the brand reads as a phishing attempt:
 *
 *   #37544F  the green — the logo's own fill, the site's buttons, and its footer band
 *   #222222  body text. Near-black, NOT a soft grey: the site is confident, not timid
 *   #1C2422  headings — a darker green-black
 *   #C4D2CF  sage, for hairlines and card borders
 *   #F7FAF9  the palest green-white, for tinted panels
 *   #EFEFEF  neutral panel grey
 *   Roboto   the site's face; 25px pill buttons; rounded cards with hairline borders
 *
 * Signature elements carried across: the **wordmark lockup** (heavy ILLION over a letter-spaced
 * TAX & ACCOUNTING), the **green footer band** the site closes on, and the site's rounded
 * hairline card, used here for the signature block.
 *
 * ## Why it looks like 2004 HTML
 *
 * Outlook renders mail through Word; Gmail strips `<style>` blocks and anything it does not
 * recognise. So: nested `<table>`, inline styles only, no flexbox, no grid, no external CSS, no
 * web fonts, no `background-image`. This is ugly to write and it is correct — the alternative is a
 * letter that collapses into an unstyled column for a third of recipients.
 *
 * Roboto is named first anyway: the clients that have it (Apple Mail, most Android) will use it,
 * and the rest fall through to Helvetica/Arial, which are close enough in colour and width.
 *
 * ## Deliverability, briefly
 *
 * Layout is the small half. The large half is DNS: SPF, DKIM and DMARC on the sending domain.
 * Without them this shell still lands in spam. See docs/modules/mailouts.md.
 */
import { MARK_END, MARK_START } from "@shared/mailouts.js";
import { type ContactField, contactsInLetter } from "@shared/schema/mailouts.js";
import { escapeHtml } from "./html.js";

const GREEN = "#37544F";
const GREEN_DEEP = "#2b423e"; // a step down, for the footer band's own hairlines
const INK = "#222222";
const INK_HEAD = "#1c2422";
const SAGE = "#c4d2cf";
const TINT = "#f7faf9";
/** The tinted container the facts and the signature both sit in — one look, one place. */
const CARD = `background:${TINT};border:1px solid ${SAGE};border-radius:14px;`;
const PAGE_BG = "#eef1f0";
const ON_GREEN = "#e8eeec"; // body text inside the green band — not pure white, easier to read

const FONT = "Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif";

/** `cid:` reference for the inline logo attachment. Must match what the mailer attaches. */
export const LOGO_CID = "firm-logo";

export interface LetterShell {
  heading: string;
  /** already-plain text; paragraphs split on blank lines, single newlines become <br> */
  body: string;
  firmName: string;
  /** the multi-line contact block — a name and a title; the buttons come from `contacts` */
  signature: string | null;
  /** the tap-to-contact buttons, one per filled field */
  contacts: ContactDetails;
  /** CAN-SPAM: required for commercial mail, omitted for transactional */
  postalAddress: string | null;
  /** absolute URL; omitted for transactional mail, which carries no unsubscribe */
  unsubscribeUrl: string | null;
  /**
   * The one thing the letter wants done, as a button.
   *
   * It exists because `body` is escaped plain text — deliberately, so a client's own
   * `Smith & Sons <Holdings>` can never become markup — which leaves no way to write a link into
   * it. Every transactional letter this app sends is the same shape: a sentence, a link, a
   * caveat. A mailout is written in a textarea and has no such thing, so it passes null
   * (user, 2026-08-31).
   */
  cta: { label: string; url: string } | null;
  /**
   * Facts about the recipient and the thing that happened — the account this concerns, the task
   * that was assigned, the day it is due.
   *
   * This is the slot a system letter uses where a mailout puts its signature and contact buttons.
   * A password reset must not invite anyone to WhatsApp the sales team; what it owes the reader
   * is which account it is about (user, 2026-08-31). Empty array draws nothing.
   */
  facts: Array<{ label: string; value: string }>;
  /**
   * Where the masthead image comes from, or null to set the wordmark in type.
   *
   * A SOURCE, not a boolean, because the two callers need different ones and getting that wrong is
   * invisible until someone looks: a real send uses `cid:firm-logo`, which resolves against the
   * letter's own attachment, while the browser preview has no attachment and must inline the bytes
   * as a `data:` URI. Passing `hasLogo: true` and hard-coding `cid:` showed a broken image in every
   * preview while claiming the letter had a logo.
   */
  logoSrc: string | null;
}

/**
 * Body text → HTML paragraphs.
 *
 * The composer is a plain textarea, so the author's line breaks are the only formatting signal
 * there is. Blank line = new paragraph, single newline = `<br>`. Everything is escaped: a client's
 * own company name goes through here, and `Smith & Sons <Holdings>` must not become markup.
 */
function paragraphs(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map(
      (block) =>
        `<p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:${INK};">` +
        escapeHtml(block).replace(/\n/g, "<br />") +
        `</p>`,
    )
    .join("\n");
}

/**
 * The masthead.
 *
 * With no logo uploaded this does NOT fall back to plain text — it draws the wordmark: a heavy,
 * tightly-tracked ILLION over a wide-tracked TAX & ACCOUNTING, which is the lockup on the site.
 * A letter whose header is an unstyled string looks like a mail-merge accident; this looks like
 * the firm even before anyone uploads a file.
 */
function masthead(shell: LetterShell): string {
  if (shell.logoSrc) {
    return (
      `<img src="${escapeHtml(shell.logoSrc)}" width="168" alt="${escapeHtml(shell.firmName)}" ` +
      `style="display:block;border:0;width:168px;max-width:100%;height:auto;" />`
    );
  }

  // The wordmark, in type. `letter-spacing` survives Outlook; `text-transform` does not, so the
  // subtitle is written in capitals rather than transformed.
  const name = escapeHtml(shell.firmName);
  const isIllion = /illion/i.test(shell.firmName);
  return [
    `<span style="display:block;font-family:${FONT};font-size:27px;line-height:1;font-weight:700;`,
    `letter-spacing:-0.4px;color:${INK_HEAD};">${isIllion ? "ILLION" : name}</span>`,
    isIllion
      ? `<span style="display:block;margin-top:5px;font-family:${FONT};font-size:9px;line-height:1;` +
        `font-weight:500;letter-spacing:3.4px;color:${GREEN};">TAX &amp; ACCOUNTING</span>`
      : "",
  ].join("");
}

// ── contact links ────────────────────────────────────────────────────────────

export interface ContactLink {
  /** a monochrome text glyph, NOT an image: it survives the image blocking every client does */
  glyph: string;
  label: string;
  href: string;
}

/** What the firm typed for each channel. Empty means no button — never a guess. */
export interface ContactDetails {
  email?: string | null;
  phone?: string | null;
  telegram?: string | null;
  whatsapp?: string | null;
  viber?: string | null;
  website?: string | null;
}

/** `+1 (704) 726-6994` → `17047266994`. `wa.me` and `t.me` reject anything else. */
const digits = (value: string) => value.replace(/\D/g, "");

/**
 * The tap-to-contact buttons, built from fields the firm filled in.
 *
 * Explicitly NOT parsed out of the signature any more. Reading them from free text meant guessing
 * whether a line was a Telegram number or a plain call, and a number written a new way produced a
 * dead link nobody would notice until a client tapped it. A field is either filled or it is not.
 *
 * A Telegram value may be a @username or a phone number — both are things people actually have,
 * and they take different URLs.
 */
export function contactLinks(contacts: ContactDetails): ContactLink[] {
  // WHICH fields survive, and in what order, is decided in `shared/schema/mailouts.ts` — the form
  // reads the same rule to tell a firm which buttons its letters will actually carry. Here we only
  // turn each surviving field into a glyph, a label and a URL.
  const build: Record<ContactField, (v: string) => ContactLink> = {
    email: (v) => ({ glyph: "✉", label: "Email", href: `mailto:${v}` }),
    phone: (v) => ({ glyph: "☎", label: "Call", href: `tel:+${digits(v)}` }),
    // a username has letters in it; a phone does not
    telegram: (v) => {
      const handle = v.replace(/^@/, "");
      return {
        glyph: "✈",
        label: "Telegram",
        href: /[a-z_]/i.test(handle)
          ? `https://t.me/${handle}`
          : `https://t.me/+${digits(handle)}`,
      };
    },
    whatsapp: (v) => ({ glyph: "✆", label: "WhatsApp", href: `https://wa.me/${digits(v)}` }),
    viber: (v) => ({
      glyph: "✆",
      label: "Viber",
      href: `viber://chat?number=%2B${digits(v)}`,
    }),
    website: (v) => ({
      glyph: "▸",
      label: v.replace(/^https?:\/\//, ""),
      href: v.startsWith("http") ? v : `https://${v}`,
    }),
  };

  return contactsInLetter(contacts).map((key) => build[key](contacts[key]!.trim()));
}

// The signature is prose now — a name and a title — but firms still type an address or a number
// into it, and a phone number you cannot tap is a small daily annoyance. These make the text
// clickable; they no longer decide anything, which is what made the old parser fragile.
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_RE = /\+?[\d][\d\s().-]{7,}\d/;
const URL_RE = /\b((?:https?:\/\/)?(?:[\w-]+\.)+(?:tax|com|net|org|io|co|ua|us))\b/i;

/**
 * One signature line, with its address / number / domain made tappable.
 *
 * Escapes FIRST and injects anchors after, so the linking can never be the hole through which
 * markup reaches the letter. Matching runs against the escaped text, which is safe here because
 * none of the three patterns can contain a character that escaping rewrites.
 */
function linkifyLine(line: string): string {
  const safe = escapeHtml(line);
  const anchor = (text: string, href: string) =>
    `<a href="${href}" style="color:${GREEN};text-decoration:none;border-bottom:1px solid ${SAGE};">${text}</a>`;

  const email = safe.match(EMAIL_RE)?.[0];
  if (email) return safe.replace(email, anchor(email, `mailto:${email}`));

  const phone = safe.match(PHONE_RE)?.[0];
  if (phone) {
    const digits = phone.replace(/\D/g, "");
    const href = /telegram/i.test(safe)
      ? `https://t.me/+${digits}`
      : /whats\s?app/i.test(safe)
        ? `https://wa.me/${digits}`
        : `tel:+${digits}`;
    return safe.replace(phone, anchor(phone, href));
  }

  const url = safe.match(URL_RE)?.[1];
  if (url) return safe.replace(url, anchor(url, url.startsWith("http") ? url : `https://${url}`));

  return safe;
}

/**
 * The tap-to-contact row, in the site's pill-button shape.
 *
 * Laid out as table cells rather than inline-blocks: Outlook collapses the gaps between
 * inline-blocks, which would run the pills into one another.
 */
function contactRow(links: ContactLink[]): string {
  if (links.length === 0) return "";

  const pill = (l: ContactLink) =>
    `<td style="padding:0 6px 8px 0;">
       <a href="${escapeHtml(l.href)}"
          style="display:inline-block;padding:9px 16px;border-radius:25px;background:${GREEN};
                 font-family:${FONT};font-size:13px;font-weight:500;line-height:1;color:#ffffff;
                 text-decoration:none;white-space:nowrap;">
         <span style="font-size:14px;">${l.glyph}</span>&nbsp;&nbsp;${escapeHtml(l.label)}
       </a>
     </td>`;

  return `<tr><td style="padding:0 34px 26px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      ${links.map(pill).join("")}
    </tr></table>
  </td></tr>`;
}

/**
 * The signature, as the site's card: pale green fill, sage hairline, rounded.
 *
 * The first line — the person's name — carries the weight; the rest is quieter. Printing the whole
 * block at one size is what made the earlier version read as a plain-text footer.
 *
 * Addresses and numbers inside it are linked too, not only in the pill row: some people tap the
 * line they are reading rather than hunting for a button.
 */
/**
 * The facts block — what this letter is about, as label/value rows.
 *
 * A transactional letter owes the reader proof it is meant for them: which account, which task,
 * which day. Rendered as a table rather than a definition list because Outlook's HTML renderer is
 * Word's, and `dl` there is a lottery.
 *
 * Values are escaped like everything else, and NOT linkified: a fact is a fact, and the one thing
 * the letter wants clicked is the button below it.
 */
function factsCard(facts: Array<{ label: string; value: string }>): string {
  if (facts.length === 0) return "";
  const rows = facts
    .map(
      (f) =>
        `<tr>` +
        `<td style="padding:0 14px 6px 0;font-family:${FONT};font-size:12px;line-height:1.5;` +
        `font-weight:500;letter-spacing:0.3px;color:${GREEN};white-space:nowrap;` +
        `vertical-align:top;">${escapeHtml(f.label)}</td>` +
        `<td style="padding:0 0 6px;font-family:${FONT};font-size:14px;line-height:1.5;` +
        `color:${INK};">${escapeHtml(f.value)}</td>` +
        `</tr>`,
    )
    .join("\n");
  return `<tr><td style="padding:4px 34px 4px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="${CARD}">
    <tr><td style="padding:16px 22px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
${rows}
      </table>
    </td></tr>
  </table>
</td></tr>`;
}

/**
 * The one thing the letter wants done.
 *
 * A table with a background, not an `<a>` with padding: Outlook ignores padding on inline
 * elements, which turns a button into bare underlined text at the exact moment it matters most.
 *
 * The href is escaped, exactly like the contact pills above. `&amp;` is the CORRECT way to write
 * an ampersand inside an attribute — every client decodes it back — so escaping costs the query
 * string nothing and closes the hole a future template would otherwise open: today these URLs are
 * built from a generated token, but the type accepts any string, and one built from user input
 * would break out of the attribute (2026-08-31 audit).
 */
/**
 * The breathing room under the transactional blocks.
 *
 * It belongs to the GROUP, not to either block, because which one comes last depends on the
 * letter: a notification may carry facts and no button. Giving each block its own bottom padding
 * meant "facts, no button" pressed the card straight against the footer band, and the combination
 * that broke it was one nothing sends yet (2026-08-31 audit).
 */
const TAIL_GAP = `<tr><td style="height:24px;line-height:24px;font-size:0;">&nbsp;</td></tr>`;

function ctaButton(cta: { label: string; url: string }): string {
  return `<tr><td style="padding:14px 34px 6px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
    <tr><td style="border-radius:10px;background:${GREEN};">
      <a href="${escapeHtml(cta.url)}"
         style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;
                font-weight:700;line-height:1;color:#ffffff;text-decoration:none;
                border-radius:10px;">${escapeHtml(cta.label)}</a>
    </td></tr>
  </table>
</td></tr>`;
}

function signatureCard(signature: string): string {
  const lines = signature
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";

  const [name, role, ...rest] = lines;
  return `<tr><td style="padding:4px 34px 30px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="${CARD}">
    <tr><td style="padding:18px 22px;">
      <p style="margin:0;font-family:${FONT};font-size:15px;font-weight:700;color:${INK_HEAD};">${escapeHtml(name)}</p>
      ${
        role
          ? `<p style="margin:3px 0 0;font-family:${FONT};font-size:12px;font-weight:500;letter-spacing:0.3px;color:${GREEN};">${escapeHtml(role)}</p>`
          : ""
      }
      ${
        rest.length
          ? `<p style="margin:12px 0 0;font-family:${FONT};font-size:13px;line-height:1.7;color:${INK};">` +
            rest.map((l) => linkifyLine(l)).join("<br />") +
            `</p>`
          : ""
      }
    </td></tr>
  </table>
</td></tr>`;
}

/**
 * The closing band, in the brand green — the note the site itself ends on.
 *
 * It carries the legal matter (postal address, unsubscribe) deliberately: those lines have to be
 * present and findable, but they are not the message, and setting them small and quiet against the
 * green is how a designed letter says so. A transactional letter has neither, so the band shrinks
 * to the wordmark alone rather than disappearing — the letter should still close on the brand.
 */
function footerBand(shell: LetterShell): string {
  const bits: string[] = [];
  if (shell.postalAddress) {
    bits.push(escapeHtml(shell.postalAddress).replace(/\n/g, "<br />"));
  }
  if (shell.unsubscribeUrl) {
    bits.push(
      `You are receiving this because you are a client of ${escapeHtml(shell.firmName)}. ` +
        `<a href="${escapeHtml(shell.unsubscribeUrl)}" style="color:#ffffff;text-decoration:underline;">Unsubscribe</a> ` +
        `from these updates — invoices and messages about your account are not affected.`,
    );
  }

  const legal = bits.length
    ? `<p style="margin:14px 0 0;font-family:${FONT};font-size:11px;line-height:1.7;color:${ON_GREEN};">
         ${bits.join(`</p><p style="margin:9px 0 0;font-family:${FONT};font-size:11px;line-height:1.7;color:${ON_GREEN};">`)}
       </p>`
    : "";

  // The masthead already sets "TAX & ACCOUNTING" as the wordmark's subtitle, and most firm names
  // contain the words anyway — repeating them here read as a stutter rather than as branding.
  return `<tr>
  <td style="padding:24px 34px 28px;background:${GREEN};border-radius:0 0 16px 16px;">
    <span style="display:block;font-family:${FONT};font-size:17px;line-height:1;font-weight:700;letter-spacing:-0.2px;color:#ffffff;">
      ${escapeHtml(shell.firmName)}
    </span>
    ${
      // the rule separates the name from the legal matter; with nothing below it, it is just a
      // dangling line — which is exactly how a transactional letter used to end
      legal
        ? `<span style="display:block;margin-top:14px;border-top:1px solid ${GREEN_DEEP};font-size:0;line-height:0;">&nbsp;</span>`
        : ""
    }
    ${legal}
  </td>
</tr>`;
}

/**
 * Turn the render marks into visible highlighting — or remove them.
 *
 * Runs on the FINISHED html, after every escape has happened, so the client's own data is still
 * escaped and only the fence characters become markup. Doing it the other way round — injecting a
 * `<span>` before escaping — would either escape the span into visible text or, worse, open the
 * one hole through which a client's company name could reach the letter as markup.
 *
 * `on: false` strips the fences instead of colouring them, which is what makes the same preview
 * request serve both states of the toggle.
 */
export function applyHighlight(html: string, on: boolean): string {
  if (!on) return html.replaceAll(MARK_START, "").replaceAll(MARK_END, "");
  return html
    .replaceAll(
      MARK_START,
      `<span style="background:#fff3bf;box-shadow:0 0 0 2px #fff3bf;border-radius:2px;color:${INK};">`,
    )
    .replaceAll(MARK_END, "</span>");
}

/** The full HTML document for one letter. */
export function renderLetter(shell: LetterShell): string {
  // `role="presentation"` keeps screen readers from announcing the layout tables as data tables.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light only" />
<title>${escapeHtml(shell.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE_BG};-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE_BG};">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <!-- width=100% + max-width, NOT width=600: a fixed pixel width does not shrink, and on a
           phone (or any narrow preview) it clips the right-hand side of every line. -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="width:100%;max-width:600px;background:#ffffff;border-radius:16px;
                    border:1px solid ${SAGE};font-family:${FONT};">

        <!-- brand stripe: the one flash of colour above the fold, and the thing the eye reads as
             "this is from them" before a single word is parsed -->
        <tr><td style="height:5px;line-height:5px;font-size:0;background:${GREEN};border-radius:16px 16px 0 0;">&nbsp;</td></tr>

        <tr><td style="padding:30px 34px 0;">${masthead(shell)}</td></tr>

        <tr>
          <td style="padding:26px 34px 0;">
            <h1 style="margin:0 0 20px;font-family:${FONT};font-size:24px;line-height:1.3;font-weight:700;letter-spacing:-0.3px;color:${INK_HEAD};">
              ${escapeHtml(shell.heading)}
            </h1>
          </td>
        </tr>

        <tr><td style="padding:0 34px 10px;">
${paragraphs(shell.body)}
        </td></tr>

${factsCard(shell.facts)}
${shell.cta ? ctaButton(shell.cta) : ""}
${shell.facts.length || shell.cta ? TAIL_GAP : ""}
${shell.signature ? signatureCard(shell.signature) : ""}
${contactRow(contactLinks(shell.contacts))}
${footerBand(shell)}
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/**
 * The plain-text alternative.
 *
 * Not decoration: a message with no text/plain part scores measurably worse with spam filters, and
 * it is the only version some clients will show. Generated from the same inputs so the two can
 * never disagree about what the letter said.
 */
export function renderLetterText(shell: LetterShell): string {
  const parts = [shell.heading, "", shell.body.replace(/\r\n/g, "\n").trim()];
  if (shell.facts.length) {
    parts.push("", ...shell.facts.map((f) => `${f.label}: ${f.value}`));
  }
  // the URL spelled out, not the label: in a text part there is nothing to click, and a reader
  // who only ever sees this version still has to be able to finish what the letter asks
  if (shell.cta) parts.push("", `${shell.cta.label}: ${shell.cta.url}`);
  if (shell.signature) parts.push("", "--", shell.signature.trim());
  parts.push("", shell.firmName);
  if (shell.postalAddress) parts.push(shell.postalAddress.trim());
  if (shell.unsubscribeUrl) {
    parts.push(
      "",
      `Unsubscribe from these updates: ${shell.unsubscribeUrl}`,
      "Invoices and messages about your account are not affected.",
    );
  }
  return parts.join("\n");
}

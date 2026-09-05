import type { GateKey } from "./access.js";

/**
 * **What the access screen says about each gate**, kept out of `shared/access.ts` on purpose.
 *
 * That file is read by the app shell on every gate check, so anything in it travels to every first
 * visit. These strings are rendered by exactly one lazy screen (Settings → Access) and quoted by
 * one server error message — 1.8 kB gzip that had no business in the first chunk (measured
 * 2026-09-07, the same lesson as the module barrels in AGENTS.md).
 *
 * **The two fields are not two lengths of the same thing.** They are shown in different places,
 * for a reason worth keeping straight when either is edited:
 *
 * - **`hint`** is what the area IS, plus any background about why it is its own switch. True
 *   whatever anybody chooses, so it lives behind the `(i)` — reference, read once.
 * - **`caveat`** is what NARROWING it does, and more importantly what it does not do. It is a
 *   consequence of a choice, so the screen prints it in place and only where the choice has
 *   actually been made. §10 of the module is blunt about why: the people using this screen must
 *   not discover that limit from a colleague.
 *
 * So a caveat is written to be read **under a gate that has just been narrowed**, in either
 * direction and in any of the states that gate offers. Phrase it as "narrowing does X, and does
 * not do Y" — never "closing", which is wrong under `read_only`.
 */
export interface GateCopy {
  /** what the area is, and why it is its own switch. Behind the (i). */
  label: string;
  hint: string;
  /** what narrowing it does and does not do. Printed in place, only once it has been narrowed. */
  caveat?: string;
}

export const GATE_COPY: Record<GateKey, GateCopy> = {
  tasks: {
    label: "Tasks",
    hint: "The board, the table and Done.",
    caveat:
      "The board goes. Client and lead names do not — they still fill the pickers on Billing, " +
      "the Calendar and Mail-outs — and task deadlines drop out of the Calendar overlay.",
  },
  clients: {
    label: "Clients",
    hint: "The client list and the client card.",
    caveat:
      "The screen goes and every change is refused. Client names do NOT go: Billing, the " +
      "Calendar, Mail-outs and the Archive all read the list to fill their pickers.",
  },
  secrets: {
    label: "Secrets",
    hint:
      "The client card's vault — portal logins, bank credentials, КЕП passwords. Its own switch " +
      "rather than part of Clients, because Clients can never be fully closed.",
    caveat:
      "The Secrets tab disappears from the client card. The value itself was never protected by " +
      "role: it needs the viewer's own password, the grant expires after five minutes, and every " +
      "look and every failed attempt is journalled. This decides who sees the tab at all.",
  },
  leads: {
    label: "Leads",
    hint: "The leads board and the pipeline behind it.",
    caveat:
      "The board goes. Lead names do not — they still fill the pickers on Tasks and the Calendar.",
  },
  billing: {
    label: "Billing",
    hint: "Invoices, payments and debt.",
    caveat:
      "The screen goes. Billing itself does not stop: completing a billable job still issues its " +
      "invoice, whoever pressed the button. Correcting an invoice or a payment stays with an " +
      "admin either way.",
  },
  calendar: {
    label: "Calendar",
    hint: "Meetings and the task-deadline overlay.",
    caveat: "The screen and the meetings on it go. Meetings raised from a task are unaffected.",
  },
  services: {
    label: "Services",
    hint: "The services catalog and its task templates.",
    caveat:
      "The EDITOR goes, the price list does not. The catalog is reference data with 19 call " +
      "sites: every task form, every invoice line and the client card still read it.",
  },
  mailouts: {
    label: "Mail-outs",
    hint: "Composer, delivery log, campaigns and templates.",
    caveat:
      "The screen goes, along with the ability to send. Letters already sent stay in the log for " +
      "anyone who can open it, and campaigns already scheduled still fire on their dates.",
  },
  mailboxes: {
    label: "Mailboxes",
    hint:
      "The Sender tab, the letterhead mark and the firm's mail address. Split out of Mail-outs " +
      "on purpose: sending a letter and rewriting the credentials the firm's mail leaves from " +
      "are not one privilege, and one of these accounts decides where invoices come from.",
    caveat:
      "The Sender tab goes, and with it the SMTP and IMAP hostnames and usernames it lists — " +
      "which is the exposure worth closing. Composing is unaffected: the From picker reads a " +
      "narrower endpoint that carries no credentials.",
  },
  archive: {
    label: "Archive",
    hint: "The archive screen — a view over archived clients, leads and tasks.",
    caveat:
      "It owns no API routes of its own, so the screen goes and the same records stay reachable " +
      "through their own modules. It also disappears on its own when Clients, Leads and Tasks " +
      "are all closed.",
  },
  settings: {
    label: "Settings",
    hint: "Firm profile, priorities, sources, invoice numbering, and the System tab.",
    caveat:
      "The EDITING screens go, the values do not: priorities, sources and the firm's own details " +
      "are read by the app shell and by every form, so “they cannot see our numbering” would be " +
      "the wrong reading. Opening this also opens the System tab, which names every background " +
      "job and the last error text each one produced.",
  },
  notification_rules: {
    label: "Notification rules",
    hint: "Settings → Notifications: which notifications the firm raises at all, and by which channel.",
    caveat:
      "Only the firm-wide policy. A person's own tray and their own preferences are never gated.",
  },
  reports: {
    label: "Reports",
    hint:
      "The dashboard and reports. Declared before the screen exists, so S12 arrives with its " +
      "gate already in place.",
  },
  team: {
    label: "Team",
    hint:
      "People, invitations and roles. Always admin and never switchable — whoever can change a " +
      "role can grant themselves every other gate, which would make this whole table decorative. " +
      "The access screen itself sits behind it.",
  },
};

import { beforeAll, describe, expect, it } from "vitest";
import {
  CRM_LINKS,
  cardsIn,
  crmLinksIn,
  isOnlyCrmLinks,
  kindOf,
  type CrmKind,
} from "./crm-links";

/**
 * **What counts as a link into this CRM** (chat.md §5.6). The card is drawn by a component and the
 * access is the record's own business; what is testable — and what a mistake here would cost — is
 * the matching: a link to somewhere else must never be treated as one of ours, and an address this
 * CRM really uses must never be missed.
 */

const HERE = "http://localhost:5173";
const ID = "3f0a8c2e-1f77-4a2c-9f3a-2b5ce2b1a911";
const OTHER = "9a1b7c3d-2e88-4b3d-8a4b-3c6df3c2b022";

beforeAll(() => {
  // `crmLinksIn` compares against the page's own origin: this suite is that page
  Object.defineProperty(globalThis, "window", {
    value: { location: { origin: HERE } },
    configurable: true,
  });
});

describe("the addresses the CRM links to", () => {
  it("matches one of every kind, and says which id it is", () => {
    const every = CRM_LINKS.map((spec) => `${HERE}${spec.href(ID)}`).join(" and ");
    // two at a time is the cap, so this is asked one kind at a time
    for (const spec of CRM_LINKS) {
      const found = crmLinksIn(`${HERE}${spec.href(ID)}`);
      expect(found, spec.kind).toEqual([
        { kind: spec.kind, id: ID, url: `${HERE}${spec.href(ID)}`, to: spec.href(ID) },
      ]);
    }
    expect(every).toContain("/tasks?task=");
  });

  it("takes at most two out of one message, which is a message and not a list", () => {
    const many = CRM_LINKS.slice(0, 4)
      .map((spec) => `${HERE}${spec.href(ID)}`)
      .join(" ");
    expect(crmLinksIn(many)).toHaveLength(2);
  });

  it("never matches another site, however much its path looks like ours", () => {
    expect(crmLinksIn(`https://evil.example.com/tasks?task=${ID}`)).toEqual([]);
    expect(crmLinksIn(`https://localhost.evil.example/clients/${ID}`)).toEqual([]);
    // the origin is what decides, not the words: a mention of the path in prose is not a link
    expect(crmLinksIn(`look at /tasks?task=${ID}`)).toEqual([]);
  });

  it("ignores an address of ours that names no record, or names a broken one", () => {
    expect(crmLinksIn(`${HERE}/tasks`)).toEqual([]);
    expect(crmLinksIn(`${HERE}/tasks?task=not-a-uuid`)).toEqual([]);
    expect(crmLinksIn(`${HERE}/clients/${ID}/files`)).toEqual([]);
    expect(crmLinksIn(`${HERE}/leads?task=${ID}`), "the right id on the wrong page").toEqual(
      [],
    );
  });

  it("reads the record's own parameter out of an address that carries the screen's filters too", () => {
    // what a person copies out of the address bar after using the screen (owner, 2026-09-20)
    expect(crmLinksIn(`${HERE}/billing?status=owed&invoice=${ID}`)).toEqual([
      {
        kind: "invoice",
        id: ID,
        url: `${HERE}/billing?status=owed&invoice=${ID}`,
        to: `/billing?status=owed&invoice=${ID}`,
      },
    ]);
    expect(crmLinksIn(`${HERE}/tasks?task=${ID}&view=board`)).toHaveLength(1);
    expect(crmLinksIn(`${HERE}/clients/${ID}/`)).toHaveLength(1);
  });

  it("keeps a sentence's punctuation out of the link", () => {
    const found = crmLinksIn(`see ${HERE}/tasks?task=${ID}, then tell me`);
    expect(found).toEqual([
      { kind: "task", id: ID, url: `${HERE}/tasks?task=${ID}`, to: `/tasks?task=${ID}` },
    ]);
  });

  it("does not name the same record twice, and does name two different ones", () => {
    const twice = `${HERE}/tasks?task=${ID} ${HERE}/tasks?task=${ID}`;
    expect(crmLinksIn(twice)).toHaveLength(1);
    expect(crmLinksIn(`${HERE}/tasks?task=${ID} ${HERE}/tasks?task=${OTHER}`)).toHaveLength(2);
  });
});

describe("a message that is nothing but links", () => {
  it("is the cards alone, and a message with words keeps its words", () => {
    expect(isOnlyCrmLinks(`${HERE}/tasks?task=${ID}`)).toBe(true);
    expect(isOnlyCrmLinks(`  ${HERE}/tasks?task=${ID}\n${HERE}/clients/${OTHER}  `)).toBe(true);
    expect(isOnlyCrmLinks(`have a look: ${HERE}/tasks?task=${ID}`)).toBe(false);
    expect(isOnlyCrmLinks("no links at all")).toBe(false);
    expect(isOnlyCrmLinks(`${HERE}/tasks?task=${ID}.`)).toBe(false);
  });
});

describe("what a message draws", () => {
  it("draws the cards alone when the message is only links, and the words otherwise", () => {
    expect(cardsIn(`${HERE}/tasks?task=${ID}`)).toEqual({
      links: [
        { kind: "task", id: ID, url: `${HERE}/tasks?task=${ID}`, to: `/tasks?task=${ID}` },
      ],
      wordsToo: false,
    });
    expect(cardsIn(`have a look: ${HERE}/tasks?task=${ID}`).wordsToo).toBe(true);
    expect(cardsIn("no links at all")).toEqual({ links: [], wordsToo: true });
  });

  it("keeps the words when a message holds more links than it draws cards for", () => {
    // at most two cards, so a third link has to stay visible as an address (audit, 2026-09-20)
    const three = `${HERE}/tasks?task=${ID} ${HERE}/clients/${OTHER} ${HERE}/leads?lead=${ID}`;
    const drawn = cardsIn(three);
    expect(drawn.links).toHaveLength(2);
    expect(drawn.wordsToo).toBe(true);
  });
});

describe("a record inside another one", () => {
  /**
   * A company, a contact person and a subscription live INSIDE a client, so their address is the
   * client's with a tab and a mark on it. They are deliberately not kinds of their own: pasted
   * into a chat they draw the CLIENT's card, which is the honest answer — that is the record, and
   * the link opens it at the part being talked about (owner, 2026-09-21).
   */
  it("is a link to its parent, opened at the right part", () => {
    const inside = `${HERE}/clients/${ID}?tab=companies&company=${OTHER}`;
    // `to` keeps the tab and the mark: clicking the card in a chat has to arrive at the company,
    // not at the client's Profile (owner, 2026-09-21)
    expect(crmLinksIn(inside)).toEqual([
      {
        kind: "client",
        id: ID,
        url: inside,
        to: `/clients/${ID}?tab=companies&company=${OTHER}`,
      },
    ]);
    expect(crmLinksIn(`${HERE}/clients/${ID}?tab=people&person=${OTHER}`)).toHaveLength(1);
    expect(crmLinksIn(`${HERE}/clients/${ID}?tab=services&subscription=${OTHER}`)).toHaveLength(
      1,
    );
  });
});

describe("the registry itself", () => {
  it("has one entry per kind, each with an address that matches its own pattern", () => {
    const kinds = CRM_LINKS.map((spec) => spec.kind);
    expect(new Set(kinds).size, "a kind twice").toBe(kinds.length);
    for (const spec of CRM_LINKS) {
      expect(kindOf(spec.kind)).toBe(spec);
      // the pattern and the address are written apart, and this is what keeps them one thing: a
      // module added with a link its own pattern does not match would draw no card at all
      expect(spec.idIn(new URL(spec.href(ID), HERE)), spec.kind).toBe(ID);
      expect(spec.label.length, spec.kind).toBeGreaterThan(0);
    }
  });
});

/**
 * **The CRM has a second place that builds these addresses**: `notificationPath`
 * (`shared/notifications.ts`), which the tray's Open button and the emails use. Nothing made the
 * two agree until this test: a kind whose address changed here and not there would send somebody
 * from their inbox to a screen with no record open (inventory, 2026-09-20).
 */
describe("the notification tray's addresses", () => {
  it("agree with the registry, kind by kind", async () => {
    const { notificationPath } = await import("@shared/notifications");
    const same: { subject: string; kind: CrmKind }[] = [
      { subject: "task", kind: "task" },
      { subject: "meeting", kind: "meeting" },
      { subject: "invoice", kind: "invoice" },
    ];
    for (const { subject, kind } of same) {
      expect(notificationPath(subject, ID), subject).toBe(kindOf(kind).href(ID));
    }
  });
});

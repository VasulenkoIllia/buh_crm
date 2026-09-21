import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { finalizeInventory, type RouteRecord } from "./core/route-inventory.js";

/**
 * **The API is enumerated, and the enumeration is committed.**
 *
 * This is the file that made the rest of the access work reviewable. Before it, nothing listed the
 * routes and nothing asserted that any of them was guarded, so removing a guard was invisible: no
 * test failed and the diff said only "one line deleted in a 300-line route file". Three route
 * counts were in circulation — 149, 154 and 156 — and none could be reconciled by reading.
 *
 * `server/route-inventory.json` is the answer, sorted and committed. Any change to the API shows
 * up here as a reviewable diff, and the totals below are literal numbers, so moving one is a
 * deliberate edit somebody signs off rather than a number that quietly drifts.
 *
 * It sits beside `schema-invariants.test.ts`, which guards the other thing a tool cannot see.
 */

let app: Awaited<ReturnType<typeof buildApp>>;
let live: RouteRecord[];
let fixture: RouteRecord[];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  live = finalizeInventory(app.routeInventory);
  fixture = JSON.parse(
    await readFile(new URL("route-inventory.json", import.meta.url), "utf8"),
  ) as RouteRecord[];
});

afterAll(async () => {
  await app?.close();
});

const key = (r: RouteRecord) => `${r.method} ${r.url}`;
const line = (r: RouteRecord) => `${key(r)} → ${r.access}${r.derived ? " (derived)" : ""}`;

describe("route inventory", () => {
  it("matches the committed fixture", () => {
    const liveByKey = new Map(live.map((r) => [key(r), r]));
    const fixtureByKey = new Map(fixture.map((r) => [key(r), r]));

    const added = live.filter((r) => !fixtureByKey.has(key(r))).map(line);
    const removed = fixture.filter((r) => !liveByKey.has(key(r))).map(line);
    const changed = live
      .filter((r) => {
        const was = fixtureByKey.get(key(r));
        return (
          was &&
          (was.access !== r.access ||
            !!was.derived !== !!r.derived ||
            !!was.beforeTwoFactor !== !!r.beforeTwoFactor ||
            !!was.stream !== !!r.stream)
        );
      })
      .map((r) => `${key(r)}: ${fixtureByKey.get(key(r))!.access} → ${r.access}`);

    expect(
      { added, removed, changed },
      "server/route-inventory.json is out of date. Regenerate it deliberately and review the " +
        "diff — an added route with the wrong gate is exactly what this file exists to surface.",
    ).toEqual({ added: [], removed: [], changed: [] });
  });

  /**
   * The numbers, written out. `derived` are the `HEAD` routes Fastify exposes for every `GET`
   * (including the trailing-slash twin of a prefixed `GET "/"`) — 59 of them, which is most of
   * why the old counts disagreed.
   */
  it("answers the counts nobody could previously reconcile", () => {
    const real = live.filter((r) => !r.derived);
    const counts = {
      total: live.length,
      derivedHead: live.length - real.length,
      real: real.length,
      api: real.filter((r) => r.url.startsWith("/api")).length,
      anonymous: real.filter((r) => r.access === "anonymous").length,
      own: real.filter((r) => r.access === "own").length,
      shared: real.filter((r) => r.access === "shared").length,
      gated: real.filter((r) => r.access.startsWith("gate:")).length,
      adminOnly: real.filter((r) => r.access.endsWith(":admin")).length,
    };
    expect(counts).toEqual({
      // +3 real routes on 2026-09-08, all of them the activity log's: the list, the event
      // switches, and the one route that flips a switch. +9 on 2026-09-12, all two-factor
      // sign-in's: the second step of signing in, the five routes on the caller's own second
      // factor, and Team's three (the overview, the rule, an admin's reset). +31 on 2026-09-14, all
      // the library's (files.md §11.1): My files and Company under `files`, a client's files under
      // `clients` wherever they are shown, and the admin's move out of a client on its own route.
      // +9 the same night for the Trash (§9): a delete from each place, its list, three restores,
      // and the client card's and the task card's Undo. +2 on 2026-09-15, both reads: the figures
      // Team sees before a Block (§8.3), and Settings → System → Storage, an admin's (§4.4). +4
      // the same day for stage C: a view beside each download (My files, Company, a client's, a
      // task's), GET only, since a HEAD would run the handler and log a view nobody made (§12.2).
      // +1 the same day: search, one box over names and details (§13). Then the security audit:
      // −4 derived HEADs, as the downloads beside those views drop theirs for the same reason, and
      // `/settings/system` is admin-only at last, as §11.1 promised. +3 the same night for folder
      // upload: the call per directory that finds or makes a folder, one per place (§7.2). And −2
      // real, −1 derived: the client card's old list and Upload, dead since its Files tab became the
      // library's own.
      // +10 on 2026-09-16, the vault's two fixed places (secrets.md §4.2): the same five routes for
      // My secrets and for Company — the list, a save, an edit, a delete into the Trash and a
      // reveal. The eight the client card used to own moved with them, from `/api/clients/:id/
      // secrets…` to `/api/secrets/…`, which is why the totals grew by the new places alone.
      // +3 the same day for moves (§7): one out of My secrets, one out of Company, and the admin's
      // own route out of a client, which is the move that changes whose credential it is. +3 for
      // the vault's Trash (§9): the list, a gesture restored, one secret restored. +2 for its
      // search and one secret's History (§10, §11), both reads. +2 for the screen itself (§15): the
      // numbers beside each place, and the clients with a list, both reads. +3 for deleting a
      // selection as one gesture (§9), one per place: My secrets, Company, a client.
      // +6 on 2026-09-17 for a text file made in the CRM (files.md §7.4): one that makes a `.txt`
      // and one that saves its text, in each of the three places a person may write in.
      // +4 for a free-form secret's files (secrets.md §21, 2026-09-18): add, open, download, remove.
      // +1 the same day, the chat's live connection (chat.md §7.1): a stream, with no derived HEAD.
      // +1 and its HEAD for who is online (§5.4), a read. +1 for the delivery test on Settings →
      // System, which sends the caller an event and changes nothing.
      // +13 for the chats themselves (chat.md §4, step A.2): the list, one chat, the people, a direct
      // chat, Saved messages, a group, its words, adding, taking out, a role, handing on, leaving,
      // and the reader's own settings; three of them reads with their HEADs.
      // +10 for the messages themselves (chat.md §5, step A.3): the history, the pinned, a send, an
      // edit, a delete, a forward, a reaction, a pin, a vote and closing a poll; two of them reads
      // with their HEADs.
      // +3 for reading (chat.md §5.4, step A.4): a read marker, a typing ping and who has read a
      // message, the last a read with its HEAD. The first two write no activity row at all.
      // +4 for files in chats (chat.md §6, step B.1): an upload, a view, a download and a photo's
      // preview. Only the preview has a HEAD — a browser sends one to revalidate a cached picture,
      // and it is the one read here that is not logged; the other two drop theirs for the reason
      // the library's do, that fastify would answer a HEAD by running the handler and logging an
      // open nobody made.
      // +1 and its HEAD for a chat's own Files tab (step B.2), a read of what the chat carries.
      // +1 and its HEAD for the word search (step B.3), one route for both boxes: the one above
      // the chat list and the one inside a chat, which differ only by naming a chat.
      // −2 on 2026-09-20 (stage C): a group has no roles, so nothing sets one and nothing hands a
      // group on. The owner's call — the only chat with a rule about who writes is the
      // announcements channel, and that rule is the FIRM's admin (chat.md §4.3).
      // +2 and their HEADs the same day, both cards behind a pasted link (chat.md §5.6): one file
      // (files.md §16) and one client. The file's is `shared()` because the file's own PLACE
      // decides who may see it, which is the service's answer and not a gate's; the client's is
      // `shared()` like the client read beside it, and exists so that scrolling a link into view
      // does not write "viewed" rows for a screen nobody opened.
      // +1 and its HEAD on 2026-09-20: a card for one secret (secrets.md §22), the read behind a
      // `/secrets?secret=…` link. Behind the vault's gate, and it answers with the PLACE and the
      // template, never the label.
      // +1 and its HEAD on 2026-09-21: a card for one FOLDER (files.md §22), the read behind a
      // `/files?folder=…` link. `shared()` like the file card beside it, and for the same reason:
      // a client's folder belongs to Clients, and the folder's own place decides in the service.
      total: 392,
      derivedHead: 98,
      real: 294,
      api: 293, // everything but /health
      anonymous: 9, // 6 credential routes, 2 unsubscribe pages, /health
      // `POST /tasks/timer/start` moved to the `tasks` gate during the 2026-09-07 audit. It takes a
      // taskId and writes against somebody else's module, so it was never really "the caller's own
      // row" — `active` and `stop` still are, and must be. The two-factor five are the caller's own
      // second factor and name nobody else.
      own: 15,
      shared: 12,
      gated: 258,
      adminOnly: 20,
    });
  });

  it("declares every route under /api", () => {
    const undeclared = live.filter((r) => r.url.startsWith("/api") && !r.access).map(key);
    expect(undeclared).toEqual([]);
  });

  /**
   * The one list nobody had ever seen: what answers without a session. It confirmed the audit's
   * count of 8 exactly — no route had been missed. The ninth, the second step of signing in, was
   * decided on 2026-09-12 (two-factor.md §5.4) and is listed here rather than slipped in.
   */
  it("keeps the unauthenticated surface to the nine routes that are meant to be public", () => {
    expect(
      live
        .filter((r) => !r.derived && r.access === "anonymous")
        .map(key)
        .sort(),
    ).toEqual([
      "GET /api/mailouts/unsubscribe/:token",
      "GET /health",
      "POST /api/auth/accept-invite",
      "POST /api/auth/forgot-password",
      "POST /api/auth/login",
      "POST /api/auth/login/2fa",
      "POST /api/auth/logout",
      "POST /api/auth/reset-password",
      "POST /api/mailouts/unsubscribe/:token",
    ]);
  });

  /**
   * **What still answers somebody the firm's two-factor rule is holding back** (two-factor.md §6.4).
   *
   * Everything else refuses them — `own()` included, because their own tray and timer carry task
   * and client names. The security review of 2026-09-12 found the whole `own()` class exempt; this
   * list is what replaced it, and a route added to it is a decision somebody reviews here.
   */
  it("keeps the routes open to a person who must enrol to the four that let them enrol", () => {
    expect(
      live
        .filter((r) => !r.derived && r.beforeTwoFactor)
        .map(key)
        .sort(),
    ).toEqual([
      "GET /api/auth/me",
      "GET /api/two-factor/me",
      "POST /api/two-factor/me/confirm",
      "POST /api/two-factor/me/setup",
    ]);
    // …and only `own()` routes may carry it: a gated or shared route is the firm's data
    expect(live.filter((r) => r.beforeTwoFactor && r.access !== "own").map(key)).toEqual([]);
  });

  /** Every declaration names a gate the registry knows, or is one of the other three kinds. */
  it("declares nothing the registry cannot resolve", () => {
    const bad = live
      .filter((r) => !["shared", "own", "anonymous"].includes(r.access))
      .filter((r) => !/^gate:[a-z_]+(:admin)?$/.test(r.access))
      .map(line);
    expect(bad).toEqual([]);
  });
});

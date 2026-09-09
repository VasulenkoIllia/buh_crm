import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { GATE_KEYS } from "@shared/access";
import { SETTINGS_GATES, SETTINGS_TABS } from "@/modules/settings";

/**
 * **Every screen sits behind a gate, or is named here as not needing one.**
 *
 * This is the screen-side twin of the guarantee `buildApp()` gives the API: a route under `/api`
 * that declares no access makes the server refuse to start, so a new endpoint cannot be shipped
 * without somebody deciding who may call it. Nothing said the same about SCREENS, and that was the
 * biggest mechanical hole left in the permissions module (`permissions.md` §21).
 *
 * It matters because a screen is not always a route. `archive` owns **zero** API routes — it is a
 * view over three other modules — so the API-side guard has nothing to say about it, and the whole
 * of its access lives in `router.tsx`. A new screen of that shape could be added, wired into the
 * sidebar, and reach everybody, with every test in the repo still green.
 *
 * The test reads `router.tsx` as text rather than importing it, for the same reason
 * `code-splitting.test.ts` does: `createBrowserRouter` wants a DOM, and the suite runs in node.
 * What it parses is the children of `AppLayout` — the signed-in shell — walked as balanced
 * top-level objects so it is indifferent to formatting.
 *
 * **`EXEMPT` is asserted whole, not just consulted.** Adding a screen and quieting the failure by
 * appending to the list is then a visible diff somebody reviews, which is the same device the
 * literal counts in `route-inventory.test.ts` use. A list that can be silently extended guards
 * nothing.
 */

/**
 * Screens that deliberately have no gate.
 *
 * The dashboard, because everybody needs somewhere to land — a person with every area closed must
 * not meet a redirect loop. Their own profile, because an admin-only Team gate must never lock
 * somebody out of their own password. And the old `/unpaid` path, which is a redirect to
 * `/billing` and inherits that screen's gate on arrival; gating the redirect as well would bounce
 * people to the dashboard instead of showing them why.
 */
const EXEMPT = ["(index)", "profile", "unpaid"];

/** The `{ … }` starting at `from`, with its own braces balanced. Strings are skipped. */
function objectAt(source: string, from: number): { text: string; end: number } {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { text: source.slice(from, i + 1), end: i + 1 };
    }
  }
  throw new Error("unbalanced object in router.tsx");
}

/**
 * Everything declared BEFORE the shell — the four screens that must work without a session, plus
 * the `/` route that mounts the shell itself.
 *
 * Walked separately because the rest of this file only looks inside `AppLayout`, and a screen
 * added out here would slip past every check in it. Found by auditing this test rather than the
 * code it guards (2026-09-08). Asserted whole for the same reason `EXEMPT` is: the set is small,
 * every member is deliberate, and a fifth is a decision.
 */
const OUTSIDE_SHELL = ["/", "/forgot-password", "/reset-password", "/set-password", "/sign-in"];

/** The children array of the `AppLayout` route — every screen reached while signed in. */
function layoutChildren(source: string): string {
  const layout = source.indexOf("element: <AppLayout />");
  expect(layout, "router.tsx no longer has an <AppLayout /> route").toBeGreaterThan(-1);
  const open = source.indexOf("[", source.indexOf("children:", layout));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "[") depth++;
    else if (source[i] === "]") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced children array in router.tsx");
}

/** Each top-level entry of that array, in order. */
function entries(children: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < children.length; i++) {
    if (children[i] !== "{") continue;
    const { text, end } = objectAt(children, i);
    out.push(text);
    i = end;
  }
  return out;
}

/** What an entry routes: its declared paths, plus `(index)` for the index route. */
function pathsIn(entry: string): string[] {
  const paths = [...entry.matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1]);
  return /index:\s*true/.test(entry) ? ["(index)", ...paths] : paths;
}

describe("every screen is behind a gate, or says why not", () => {
  it("gates every route in the signed-in shell", async () => {
    const source = await readFile(new URL("./router.tsx", import.meta.url), "utf8");
    const all = entries(layoutChildren(source));
    expect(
      all.length,
      "the parse found no routes — router.tsx has changed shape",
    ).toBeGreaterThan(5);

    const ungated = all.filter((e) => !e.includes("RequireGate")).flatMap(pathsIn);

    expect(
      ungated.sort(),
      'a screen reachable while signed in with no gate on it. Wrap it in <RequireGate gate="…" ' +
        "/>, or — if it genuinely must be open to everybody — add it to EXEMPT above with the " +
        "reason, which is a decision somebody reviews rather than a test somebody quiets.",
    ).toEqual([...EXEMPT].sort());
  });

  /**
   * Asserted whole so the exemption list cannot grow quietly. Three screens, each argued in the
   * comment on `EXEMPT`; a fourth is a decision, not a fix.
   */
  it("keeps the ungated list to the three screens that are argued for", () => {
    expect(EXEMPT).toEqual(["(index)", "profile", "unpaid"]);
  });

  /**
   * The auth screens carry no gate because nobody is signed in yet: `PublicOnly` bounces a session
   * away from sign-in, and the two token links have to work for somebody who has no account state
   * at all. A NEW route out here would have neither a gate nor `RequireAuth`, which is a larger
   * mistake than an ungated screen inside the shell — and until this assertion existed, a quieter
   * one.
   */
  it("keeps the pre-shell routes to the four that need no session", async () => {
    const source = await readFile(new URL("./router.tsx", import.meta.url), "utf8");
    const beforeShell = source.slice(0, source.indexOf("element: <AppLayout />"));
    const paths = [...beforeShell.matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(
      [...new Set(paths)].sort(),
      "a route declared outside the signed-in shell. It has no gate and no RequireAuth — if that " +
        "is deliberate it belongs in OUTSIDE_SHELL with the reason.",
    ).toEqual(OUTSIDE_SHELL);
  });

  /**
   * **A screen holding several areas opens while ANY of them is open.**
   *
   * Settings is the only such screen, and it is where this went wrong: the route named
   * `["settings", "activity"]` while the strip also holds the ACCESS TABLE (`team`) and the
   * notification rules. Closing `settings` and `activity` for the admin role — two switches, both
   * offered on the access screen itself — bounced every admin off `/settings` and took away the one
   * screen that could put either back (audit, 2026-09-09).
   *
   * Both the route and the sidebar item now spread `SETTINGS_GATES`, which is derived from the
   * strip. This asserts they still do, because a hand-written list here is exactly what failed.
   */
  it("opens Settings for every gate its tab strip can hold", async () => {
    const router = await readFile(new URL("./router.tsx", import.meta.url), "utf8");
    const layout = await readFile(new URL("./layout.tsx", import.meta.url), "utf8");

    const tabGates = SETTINGS_TABS.flatMap((t) => (t.gate ? [t.gate] : []));
    expect(
      [...SETTINGS_GATES].sort(),
      "SETTINGS_GATES must cover `settings` plus every gate a tab names",
    ).toEqual([...new Set(["settings", ...tabGates])].sort());

    /**
     * Read with whitespace collapsed, and by looking for the guard NEAREST the route rather than
     * on the same line as it. The first version of this asserted both halves appeared on one
     * source line, which is a fact about line breaks and not about access: running the repository's
     * own `npm run format` reflowed the router and failed this test while the routing was correct
     * (2026-09-09). A test that a formatter can break is a test that will be silenced.
     */
    const flat = router.replace(/\s+/g, " ");
    const route = flat.indexOf('path: "settings"');
    expect(route, "the Settings route is gone from the router").toBeGreaterThan(-1);
    const guard = flat.lastIndexOf("<RequireGate", route);
    expect(
      guard === -1 ? "" : flat.slice(guard, route),
      "the Settings route must spread SETTINGS_GATES — a hand-written list drifts from the strip " +
        "and locks the Access tab away",
    ).toContain("...SETTINGS_GATES");
    expect(
      layout.replace(/\s+/g, " "),
      "the sidebar item must spread SETTINGS_GATES too, or the screen is reachable and invisible",
    ).toContain("gate: [...SETTINGS_GATES]");
  });

  it("names only gates the registry knows", async () => {
    const source = await readFile(new URL("./router.tsx", import.meta.url), "utf8");
    const named = [
      ...layoutChildren(source).matchAll(/<RequireGate\s+gate=\{?\s*(\[[^\]]*\]|"[^"]+")/g),
    ].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((g) => g[1]));

    expect(named.length, "no RequireGate found — the parse has drifted").toBeGreaterThan(5);
    expect(named.filter((g) => !(GATE_KEYS as string[]).includes(g))).toEqual([]);
  });
});

import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * **A control inside a control is not a control.**
 *
 * `RowButton` is a `<button>`: the whole row is the thing you press. Putting another button inside
 * it — a copy link, an icon action — is invalid HTML, and the browser is under no obligation to
 * deliver the inner click at all. A `<span onClick={stopPropagation}>` around it looks like it
 * settles the matter and does not: it guards the mouse and leaves the structure, so a keyboard and
 * a screen reader still meet two nested pressable things.
 *
 * This happened twice on the same day, 2026-09-21, in work that was adding the same copy button to
 * every kind of row: meetings and invoices put it beside the row and tasks put it inside, and the
 * chat's Files tab did the same to its documents. Both were found by reading, which is not a
 * method. The shape is mechanical, so the check is.
 *
 * The fix is always the same: make the row a flex container, give `RowButton` `flex-1`, and stand
 * the other control next to it.
 */
const INTERACTIVE = /<(button|a|RowButton|IconButton|Button|CopyLink|ClearButton|Link)[\s>]/;

/** The source of every screen and component, from git so that nothing untracked is judged. */
async function tsxFiles(): Promise<string[]> {
  const listed = execFileSync("git", ["ls-files", "src"], {
    cwd: new URL("../../", import.meta.url).pathname,
    encoding: "utf8",
  });
  return listed.split("\n").filter((f) => f.endsWith(".tsx"));
}

describe("nothing pressable is nested inside something pressable", () => {
  it("no RowButton has another control among its children", async () => {
    const root = new URL("../../", import.meta.url);
    const offenders: string[] = [];

    for (const file of await tsxFiles()) {
      const source = await readFile(new URL(file, root), "utf8");
      let at = source.indexOf("<RowButton");
      while (at !== -1) {
        const openEnds = source.indexOf(">", at);
        // `<RowButton … />` holds nothing, so it can hold nothing wrong
        const selfClosing = source
          .slice(at, openEnds + 1)
          .trimEnd()
          .endsWith("/>");
        if (!selfClosing) {
          const closeAt = source.indexOf("</RowButton>", openEnds);
          const children = source.slice(openEnds + 1, closeAt === -1 ? undefined : closeAt);
          const found = INTERACTIVE.exec(children);
          if (found) {
            const line = source.slice(0, openEnds + 1 + (found.index ?? 0)).split("\n").length;
            offenders.push(`${file}:${line} — <${found[1]}> inside a RowButton`);
          }
        }
        at = source.indexOf("<RowButton", openEnds);
      }
    }

    expect(
      offenders,
      "Stand the other control BESIDE the row, not inside it: wrap both in a flex container and " +
        "give the RowButton flex-1. See src/modules/calendar/entity-meetings.tsx for the shape.",
    ).toEqual([]);
  });

  /**
   * The message menu walks itself with the arrow keys, and it finds its items by
   * `[data-menu-item]`. An action without the attribute is invisible to the keyboard while being
   * perfectly visible to the eye — which is how Delete, the one item nobody should reach by
   * accident and everybody should be able to reach on purpose, was unreachable for a day
   * (audit, 2026-09-21).
   */
  it("every action in the message menu is reachable by the keyboard", async () => {
    const file = await readFile(
      new URL("../modules/chat/message-menu.tsx", import.meta.url),
      "utf8",
    );
    // MessageMenu only. `ReactionPicker` shares the file and is a floating strip of emoji, not a
    // menu: it is walked with Tab like anything else on the page, and has no items to mark.
    const at = file.indexOf("export function MessageMenu");
    expect(at, "MessageMenu moved out of this file").toBeGreaterThan(-1);
    const source = file.slice(at);
    const buttons = source.split("<button").slice(1);
    const deaf = buttons.filter((b) => {
      const tag = b.slice(0, b.indexOf(">"));
      return !tag.includes("data-menu-item");
    });
    expect(
      deaf.map((b) => b.slice(0, 80).replace(/\s+/g, " ").trim()),
      "Give it data-menu-item, or the arrows walk straight past it.",
    ).toEqual([]);
  });
});

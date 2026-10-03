import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import ts from "typescript";
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

/** Pressing it does something, so it must not be inside something else you press. */
const CONTROL = new Set([
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "Button",
  "IconButton",
  "RowButton",
  "ChipButton",
  "ClearButton",
  "CopyLink",
  "Link",
  "Menu",
  "DoneToggle",
  "TaskTimerButton",
  "AssignMenu",
]);

/**
 * All of them except `Menu`, which is not itself pressable: its `button` prop renders the trigger
 * IN ITS PLACE, so what looks nested in the source stands on its own on the screen. A `Menu` found
 * inside one of the others is still an offence — that trigger really would be nested.
 */
const HOLDS = new Set([...CONTROL].filter((tag) => tag !== "Menu"));

/** The source of every screen and component, from git so that nothing untracked is judged. */
function tsxFiles(): string[] {
  const listed = execFileSync("git", ["ls-files", "src"], {
    cwd: new URL("../../", import.meta.url).pathname,
    encoding: "utf8",
  });
  return listed.split("\n").filter((f) => f.endsWith(".tsx"));
}

describe("nothing pressable is nested inside something pressable", () => {
  /**
   * Read with the compiler's own parser rather than by matching text.
   *
   * The scan this replaces looked for the first `>` after an opening tag, which lands inside
   * `onClick={() => …}` — so it judged the wrong span of a file and was as likely to miss a real
   * one as to invent it. It also only ever looked at `RowButton`, and the shape is not about
   * `RowButton`: the tasks table was one `<button>` wrapping a whole row until 2026-10-03, when an
   * assignee that can be CHANGED from the row had to go into it.
   *
   * What it cannot see, and both are worth knowing:
   *
   * - **A tag chosen at runtime.** The tasks row was exactly that
   *   (`const Row = selectable ? "div" : "button"`), so this would not have caught the one that
   *   prompted it. Write the tag.
   * - **A component not in the list.** `CONTROL` is kept by hand, so a new wrapper that renders a
   *   `<button>` is invisible until somebody adds it — `AssignMenu` was, for an afternoon. Add
   *   the name in the same change that adds the component.
   */
  it("no control has another control among its children", async () => {
    const root = new URL("../../", import.meta.url);
    const offenders: string[] = [];

    for (const file of tsxFiles()) {
      const source = ts.createSourceFile(
        file,
        await readFile(new URL(file, root), "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const walk = (node: ts.Node, inside: string | null) => {
        let next = inside;
        const open = ts.isJsxElement(node)
          ? node.openingElement
          : ts.isJsxSelfClosingElement(node)
            ? node
            : null;
        if (open) {
          const tag = open.tagName.getText();
          if (inside && CONTROL.has(tag)) {
            const { line } = source.getLineAndCharacterOfPosition(open.getStart());
            offenders.push(`${file}:${line + 1} — <${tag}> inside <${inside}>`);
          }
          if (HOLDS.has(tag)) next = tag;
        }
        node.forEachChild((child) => walk(child, next));
      };
      walk(source, null);
    }

    expect(
      offenders,
      "Stand the other control BESIDE the row, not inside it: wrap both in a flex container and " +
        "give the row flex-1. See src/modules/calendar/entity-meetings.tsx for the shape.",
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

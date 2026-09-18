import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * The tasks board card must name itself as the drag's activator.
 *
 * dnd-kit's keyboard sensor listens for Space and Enter on the element the listeners are spread
 * on, and React bubbles every key pressed inside that element to it. With no activator named, the
 * sensor takes a key from ANY descendant, calls `preventDefault` and starts a keyboard drag. On the
 * board that descendant was the Stop timer window, drawn inside the card: a space typed into the
 * comment never arrived, and the window shrank into the lifted card (user, 2026-09-18).
 *
 * Named, the sensor ignores a key whose target is anything but the card. Nothing on screen shows
 * the difference until somebody types a space, which is why this is a test and not only a comment.
 * jsdom does no events worth the name here, so it is read out of the source, the same shape as
 * `card-title-layout.test.ts`: the activator must be set in the SAME callback, on the same node,
 * as the card's own ref.
 *
 * Not held here, with reasons (audit, 2026-09-18): the leads board shares the keyboard sensor, but
 * its card has nothing focusable inside; the Files browser registers the pointer sensor only; the
 * board's columns, the lead stages and the service catalog drag by a handle with nothing in it.
 */
const CARD = "src/modules/tasks/tasks.page.tsx";

describe("the tasks board card", () => {
  it("starts a keyboard drag only from itself", async () => {
    const source = await readFile(CARD, "utf8");
    expect(
      source,
      `${CARD}: the card's ref must call setNodeRef and setActivatorNodeRef on the same node`,
    ).toMatch(/setNodeRef\((\w+)\);\s*setActivatorNodeRef\(\1\);/);
  });
});

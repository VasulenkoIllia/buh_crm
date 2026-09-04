import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * A board card's title must be allowed to shrink AND to break.
 *
 * A flex child defaults to `min-width: auto`, which means it will not go narrower than its longest
 * word — and the Done toggle beside it is `flex-none`. Neither yields, so in a narrow column the
 * row overflowed the card and the button hung outside the border. Measured at the column's 230px
 * floor: "зарегестрировать sales tax" pushed it 2px past the edge, a longer single word 54px
 * (user, 2026-09-04).
 *
 * Both classes are needed and they fail differently: without `min-w-0` the box never shrinks;
 * without `break-words` it shrinks and the word spills out of it instead. Neither failure is
 * visible until somebody types a long word into a narrow column, which is why this is a test and
 * not a comment.
 *
 * jsdom does no layout, so it is read out of the source — the same shape as the invoice table's
 * width check next door.
 */
const CARD = "src/modules/tasks/tasks.page.tsx";

describe("the board card's title row", () => {
  it("lets the title shrink and wrap beside the Done toggle", async () => {
    const source = await readFile(CARD, "utf8");

    // the row: title div, then <DoneToggle … compact />
    const row = source.match(
      /<div className="flex items-start justify-between gap-2">[\s\S]{0,1400}?<DoneToggle[^>]*compact[^>]*\/>/,
    );
    expect(row, `no title+DoneToggle row found in ${CARD}`).not.toBeNull();

    const titleClass = row![0].match(/<div className="([^"]*font-semibold[^"]*)"/);
    expect(titleClass, "the title div in that row has no className").not.toBeNull();

    expect(titleClass![1], "the title must be able to shrink below its longest word").toContain(
      "min-w-0",
    );
    expect(titleClass![1], "a long word must wrap rather than set the width").toMatch(
      /break-words|break-all|wrap-anywhere/,
    );
  });
});

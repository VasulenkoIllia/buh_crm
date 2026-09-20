import { describe, expect, it } from "vitest";
import { mentionQuery, putMention } from "./mentions";

/**
 * **Naming somebody with `@`** (chat.md §5.2). The picker and the keys are the composer's; what is
 * testable here is the pair that decides WHEN a name is being typed and WHAT the field then holds.
 *
 * The regression these guard is the one the owner found on 2026-09-20: pressing Enter on the
 * picker left it open, and a second Enter wrote the name again on top of itself — the field read
 * "@Iryna Shevchuk ryna Shevchuk". The cause was a caret read one render late, so a query taken
 * from the finished text still looked unfinished.
 */
describe("when a name is being typed", () => {
  it("sees the word after an `@` that starts a word", () => {
    expect(mentionQuery("@Ir", 3)).toEqual({ at: 0, query: "Ir" });
    expect(mentionQuery("hello @Ir", 9)).toEqual({ at: 6, query: "Ir" });
    // a surname is a second word, because that is how people are named
    expect(mentionQuery("@Iryna She", 10)).toEqual({ at: 0, query: "Iryna She" });
  });

  it("sees nothing where there is no name to type", () => {
    expect(mentionQuery("no at sign", 10)).toBeNull();
    // an email address is not a mention: the `@` is inside a word
    expect(mentionQuery("write to olena@firm.com", 23)).toBeNull();
    // three words is a sentence, not a name
    expect(mentionQuery("@one two three", 14)).toBeNull();
    expect(mentionQuery("@over\nthe line", 14)).toBeNull();
  });

  it("is over once the name is in, which is what kept the picker open", () => {
    const typed = "@Ir";
    const put = putMention(typed, mentionQuery(typed, 3)!, "Iryna Shevchuk");
    expect(put.text).toBe("@Iryna Shevchuk ");
    expect(put.caret).toBe(16);
    // with the caret where the insertion left it, nothing is being typed any more
    expect(mentionQuery(put.text, put.caret)).toBeNull();
    // and this is what used to happen: the caret still at 3, one render behind, so the finished
    // text looked like a name half typed and the picker stayed open on it
    expect(mentionQuery(put.text, 3)).toEqual({ at: 0, query: "Ir" });
  });
});

describe("what the field holds afterwards", () => {
  it("keeps what was written after the name, with one space between", () => {
    const text = "@Ir and Petro";
    const put = putMention(text, mentionQuery(text, 3)!, "Iryna Shevchuk");
    expect(put.text).toBe("@Iryna Shevchuk and Petro");
    expect(put.caret).toBe(16);
  });

  it("keeps what was written before it", () => {
    const text = "please ask @Ir";
    const put = putMention(text, mentionQuery(text, 14)!, "Iryna Shevchuk");
    expect(put.text).toBe("please ask @Iryna Shevchuk ");
  });

  it("writes `@all` like any other name", () => {
    const put = putMention("@al", mentionQuery("@al", 3)!, "all");
    expect(put.text).toBe("@all ");
  });
});

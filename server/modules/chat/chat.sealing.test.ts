import { describe, expect, it, vi } from "vitest";
import {
  UNREADABLE,
  openGroup,
  openOptions,
  openText,
  sealGroup,
  sealOptions,
  sealText,
} from "./chat.sealing.js";

/**
 * **A row that will not open is one row, not the screen** (chat.md §9).
 *
 * Every caller of these is inside a loop over a person's whole chat list, a page of history or a
 * search's candidates. Until 2026-09-20 a single damaged value — a partial restore, a key rotated
 * without its `keyVersion`, a truncated `Bytes` write — threw out of `open()` and took away ALL of
 * that person's chats rather than the one that was hurt (audit).
 */
describe("what a sealed value does when it cannot be opened", () => {
  const damage = (sealed: ReturnType<typeof sealText>) => ({
    ...sealed,
    // one byte of the tag: GCM refuses it, which is the whole point of GCM
    authTag: Uint8Array.from([sealed.authTag[0] ^ 0xff, ...sealed.authTag.slice(1)]),
  });

  it("opens what was sealed", () => {
    expect(openText(sealText("the quarterly reconciliation"))).toBe(
      "the quarterly reconciliation",
    );
    expect(openGroup(sealGroup({ title: "Tax season", description: null }))).toEqual({
      title: "Tax season",
      description: null,
    });
    expect(openOptions(sealOptions(["Wednesday", "Thursday"]))).toEqual([
      "Wednesday",
      "Thursday",
    ]);
  });

  it("says so and carries on, rather than throwing at whoever was reading", () => {
    const complained = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(openText(damage(sealText("Petrenko's 1040")))).toBe(UNREADABLE);
      expect(openGroup(damage(sealGroup({ title: "Tax season", description: null })))).toEqual({
        title: UNREADABLE,
        description: null,
      });
      expect(openOptions(damage(sealOptions(["Wednesday"])))).toEqual([]);
      expect(complained).toHaveBeenCalled();
      // and never the ciphertext or the words in the log
      const said = complained.mock.calls.flat().join(" ");
      expect(said).toContain("would not open");
      expect(said).not.toContain("Petrenko");
    } finally {
      complained.mockRestore();
    }
  });

  it("is still nothing at all when there was nothing sealed", () => {
    const empty = { ciphertext: null, iv: null, authTag: null, keyVersion: 1 };
    expect(openText(empty)).toBeNull();
    expect(openGroup(empty)).toBeNull();
    expect(openOptions(empty)).toEqual([]);
  });
});

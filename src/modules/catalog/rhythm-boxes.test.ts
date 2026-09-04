import { describe, expect, it } from "vitest";
import { dayBoxValue, dayFromBox, offsetBoxValue, offsetFromBox } from "./task-rhythm-fields";

/**
 * Type a number into a controlled box, one keystroke at a time.
 *
 * This is the loop that was broken: the browser appends the key to whatever the box CURRENTLY
 * shows, the handler turns that text into state, and React immediately re-renders the box from
 * that state. A box that does not echo its own value therefore erases the digits already typed —
 * and the erasure is invisible, because the pill that swallowed them lights up instead.
 */
function typeInto<T>(
  keys: string,
  show: (v: T) => string,
  read: (text: string) => T,
  from: T,
): T {
  let state = from;
  for (const key of keys) state = read(show(state) + key);
  return state;
}

describe("the rhythm day box", () => {
  it("echoes every day it accepts — matching a pill does not make a value less real", () => {
    for (let d = 1; d <= 31; d++) expect(dayBoxValue(d)).toBe(String(d));
  });

  it("leaves “Last day” to its pill: -1 is not something you type into a 1–31 box", () => {
    expect(dayBoxValue(-1)).toBe("");
  });

  /** The reported bug: "15" arrived as 5, because the box blanked itself on the "1". */
  it("takes 15 as 15", () => {
    expect(typeInto("15", dayBoxValue, dayFromBox, null)).toBe(15);
  });

  it("takes every day 1–31 as itself, typed digit by digit", () => {
    for (let d = 1; d <= 31; d++) {
      expect(typeInto(String(d), dayBoxValue, dayFromBox, null), `typing ${d}`).toBe(d);
    }
  });

  it("clearing the box means the 1st, which is what the lit pill then says", () => {
    expect(dayFromBox("")).toBe(1);
  });
});

describe("the deadline offset box", () => {
  it("echoes every offset it accepts, presets included", () => {
    for (let d = 0; d <= 90; d++) expect(offsetBoxValue(d)).toBe(String(d));
  });

  /** The worse half: "12" left the box EMPTY with "+2 days" lit — 12 days silently became 2. */
  it("takes 12 as 12", () => {
    expect(typeInto("12", offsetBoxValue, offsetFromBox, null)).toBe(12);
  });

  it("takes every offset 0–90 as itself, typed digit by digit", () => {
    for (let d = 0; d <= 90; d++) {
      expect(typeInto(String(d), offsetBoxValue, offsetFromBox, null), `typing ${d}`).toBe(d);
    }
  });

  it("is empty for “none”, and clearing it means none", () => {
    expect(offsetBoxValue(null)).toBe("");
    expect(offsetFromBox("")).toBeNull();
  });
});

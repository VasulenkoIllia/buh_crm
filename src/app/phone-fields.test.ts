import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * The phone's rule for fields works only outside `@layer`.
 *
 * Tailwind's utilities live in a layer, and anything unlayered beats every layer whatever its
 * specificity. That is the only reason one rule can lift a field that carries `h-9` and
 * `text-[13px]`. Moved into `@layer base` beside the cursor rules it still reads correctly and
 * does nothing, and no other test would notice: iOS would simply zoom again.
 */
const CSS = new URL("../styles/globals.css", import.meta.url);

describe("every field fits a phone", () => {
  it("keeps the 16px and 44px rule outside any layer", async () => {
    const css = (await readFile(CSS, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
    const at = css.indexOf("@variant max-sm");
    expect(at, "the phone rule is gone from globals.css").toBeGreaterThan(-1);

    const before = css.slice(0, at);
    const opened = before.split("{").length - before.split("}").length;
    const enclosing = before.slice(before.lastIndexOf("}") + 1).trim();
    expect(opened, "the rule must sit one block deep").toBe(1);
    expect(enclosing, "that block must be its selector, not an at-rule").toMatch(/^input/);

    const rule = css.slice(at);
    expect(rule).toContain("font-size: 16px");
    expect(rule).toContain("min-height: 44px");
  });
});

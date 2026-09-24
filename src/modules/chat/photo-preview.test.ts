import { describe, expect, it } from "vitest";
import { PREVIEW_MAX, drawPreview, fitInto, looksLikeAPhoto } from "./photo-preview";

/**
 * The arithmetic behind a photo's preview (chat.md §6.2). Drawing one needs a browser; what a test
 * can hold is the part that decides its size, and which files are even tried.
 */
describe("a photo's preview", () => {
  it("fits the longest side, keeping the shape", () => {
    expect(fitInto(3200, 2400)).toEqual({ width: 960, height: 720 });
    expect(fitInto(1200, 4800)).toEqual({ width: 240, height: 960 });
  });

  it("never makes a small picture bigger", () => {
    expect(fitInto(120, 80)).toEqual({ width: 120, height: 80 });
  });

  it("keeps a line of one pixel visible rather than rounding it away", () => {
    expect(fitInto(4000, 1)).toEqual({ width: 960, height: 1 });
  });

  it("draws for a retina screen, so a bubble never upscales one", () => {
    // a bubble is at most ~420 CSS px wide; at 2× that is 840 device px, and this is over it
    expect(PREVIEW_MAX).toBeGreaterThanOrEqual(840);
  });

  it("is tried on the photos a browser may decode, and on nothing else", () => {
    expect(looksLikeAPhoto("image/jpeg")).toBe(true);
    // Safari can draw these; elsewhere the drawing fails and the photo goes as a card
    expect(looksLikeAPhoto("image/heic")).toBe(true);
    expect(looksLikeAPhoto("application/pdf")).toBe(false);
    expect(looksLikeAPhoto("image/svg+xml")).toBe(false);
  });

  /**
   * A JPEG has no alpha channel, so a transparent pixel drawn onto a fresh canvas — which is
   * transparent BLACK — encodes as black. Every logo sent into the chat arrived as a black
   * rectangle while its full-size picture opened perfectly in the viewer (production, 2026-09-24).
   *
   * The environment here is Node, so the browser is faked down to the one thing that matters: the
   * order of the two calls. White must be laid down BEFORE the picture, or it paints over it.
   */
  it("paints white under the picture, before drawing it", async () => {
    const calls: string[] = [];
    const ctx = {
      imageSmoothingQuality: "",
      fillStyle: "",
      fillRect: () => calls.push("fill"),
      drawImage: () => calls.push("draw"),
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ctx,
      toBlob: (done: (b: Blob | null) => void) => done(new Blob(["x"])),
    };
    const globals = globalThis as unknown as Record<string, unknown>;
    globals.document = { createElement: () => canvas };
    globals.createImageBitmap = () => Promise.resolve({ width: 100, height: 50, close() {} });
    try {
      await drawPreview({ type: "image/png" } as File);
      expect(calls, "white first, then the picture on top of it").toEqual(["fill", "draw"]);
      expect(ctx.fillStyle, "and the white is white").toBe("#ffffff");
    } finally {
      delete globals.document;
      delete globals.createImageBitmap;
    }
  });
});

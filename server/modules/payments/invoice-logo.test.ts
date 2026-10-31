import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { isDamagedPng } from "./invoice-logo.js";
import { chunk, png, PNG_SIGNATURE, smallPng } from "../../test/png.js";

describe("a PNG pdfkit may be given", () => {
  it("passes a sound image", () => {
    expect(isDamagedPng(smallPng())).toBe(false);
  });

  it("passes a palette image and a grey one", () => {
    expect(isDamagedPng(png({ colorType: 3, rows: [[0, 0, 0]] }))).toBe(false);
    expect(isDamagedPng(png({ colorType: 0, rows: [[0, 0, 0]] }))).toBe(false);
  });

  it("leaves a JPEG and anything else to pdfkit, which refuses those synchronously", () => {
    expect(isDamagedPng(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe(false);
    expect(isDamagedPng(Buffer.from("not an image"))).toBe(false);
  });

  it("refuses pixels that do not inflate, which would throw out of reach", () => {
    expect(isDamagedPng(png({ idat: Buffer.from("garbage") }))).toBe(true);
  });

  it("refuses a row with a filter that does not exist", () => {
    expect(isDamagedPng(png({ rows: [[9, 1, 2, 3, 4, 5, 6, 7, 8]] }))).toBe(true);
  });

  it("refuses a chunk with a negative length, which would spin for ever", () => {
    const spinning = Buffer.concat([PNG_SIGNATURE, chunk("abcd", Buffer.alloc(0), 0xfffffff4)]);
    expect(isDamagedPng(spinning)).toBe(true);
  });

  it("refuses what only looks like a PNG in the four bytes pdfkit reads", () => {
    const looksLikeOne = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      Buffer.alloc(40),
    ]);
    expect(isDamagedPng(looksLikeOne)).toBe(true);
  });

  it("refuses a file that ends before it should", () => {
    expect(isDamagedPng(smallPng().subarray(0, 30))).toBe(true);
    expect(isDamagedPng(PNG_SIGNATURE)).toBe(true);
  });

  it("refuses too few rows, too many, and a zero size", () => {
    expect(isDamagedPng(png({ height: 2 }))).toBe(true);
    expect(isDamagedPng(png({ idat: deflateSync(Buffer.alloc(100)) }))).toBe(true);
    expect(isDamagedPng(png({ width: 0 }))).toBe(true);
  });

  it("refuses an interlaced image and a depth the format does not have", () => {
    expect(isDamagedPng(png({ interlace: 1 }))).toBe(true);
    expect(isDamagedPng(png({ depth: 3 }))).toBe(true);
    expect(isDamagedPng(png({ colorType: 5 }))).toBe(true);
  });

  it("refuses a small file that claims gigabytes of pixels", () => {
    expect(isDamagedPng(png({ width: 100_000, height: 100_000 }))).toBe(true);
  });
});

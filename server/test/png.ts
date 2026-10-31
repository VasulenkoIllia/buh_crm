import { deflateSync } from "node:zlib";

/** Small PNGs built by hand, sound or damaged in one known way. Used by tests only. */

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `size` is what the length field claims, which a damaged chunk does not match. No checksum. */
export function chunk(type: string, body: Buffer, size = body.length) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(size, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body, Buffer.alloc(4)]);
}

interface PngShape {
  width?: number;
  height?: number;
  depth?: number;
  colorType?: number;
  interlace?: number;
  /** each row's filter byte and pixels */
  rows?: number[][];
  /** the compressed pixels as they are, in place of `rows` */
  idat?: Buffer;
}

/** A 2×1 RGBA image unless told otherwise. */
export function png({
  width = 2,
  height = 1,
  depth = 8,
  colorType = 6,
  interlace = 0,
  rows = [[0, 1, 2, 3, 4, 5, 6, 7, 8]],
  idat,
}: PngShape = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = colorType;
  header[12] = interlace;
  const pixels = idat ?? deflateSync(Buffer.from(rows.flat()));
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const smallPng = () => png();

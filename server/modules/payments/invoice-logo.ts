import { inflateSync } from "node:zlib";

/**
 * **Whether a PNG may be handed to pdfkit** (payments.md §10).
 *
 * pdfkit reads a PNG with png-js, which decodes inside a zlib callback, so a damaged image throws
 * where no try/catch reaches and ends the one process serving the firm. A chunk with a negative
 * length spins it for ever instead (security review, 2026-10-31). A logo is somebody's upload with
 * a claimed type, so it is read here first, strictly: anything odd costs the logo, not the server.
 */

/** What pdfkit itself looks at to take a file for a PNG: four bytes, so these are the ones asked. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const SIGNATURE = Buffer.concat([PNG_MAGIC, Buffer.from([0x0d, 0x0a, 0x1a, 0x0a])]);

/** a chunk's length, type and checksum around its body */
const CHUNK_FRAME_BYTES = 12;
const HEADER_BYTES = 13;
const LAST_FILTER = 4;
/** 8 million RGBA pixels: past any letterhead, and it stops a small file inflating into gigabytes */
const MAX_PIXEL_BYTES = 32 * 1024 * 1024;

const FORMATS: Record<number, { channels: number; depths: number[] }> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};

function readChunks(png: Buffer) {
  const pixels: Buffer[] = [];
  let header: Buffer | null = null;
  let at = SIGNATURE.length;
  while (at + CHUNK_FRAME_BYTES <= png.length) {
    const size = png.readUInt32BE(at);
    const end = at + CHUNK_FRAME_BYTES + size;
    if (end > png.length) return null;
    const type = png.toString("latin1", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + size);
    if (type === "IHDR") header = body;
    if (type === "IDAT") pixels.push(body);
    if (type === "IEND") {
      return header && pixels.length > 0 ? { header, pixels: Buffer.concat(pixels) } : null;
    }
    at = end;
  }
  return null;
}

/** Every row is present and names a filter png-js knows, which is what it would have thrown on. */
function hasValidRows(pixels: Buffer, rowBytes: number, totalBytes: number) {
  try {
    const raw = inflateSync(pixels, { maxOutputLength: totalBytes });
    if (raw.length !== totalBytes) return false;
    for (let row = 0; row < totalBytes; row += rowBytes) {
      if (raw[row] > LAST_FILTER) return false;
    }
    return true;
  } catch {
    return false; // a stream that does not inflate is the damage being looked for
  }
}

function isSoundPng(png: Buffer) {
  if (!png.subarray(0, SIGNATURE.length).equals(SIGNATURE)) return false;
  const chunks = readChunks(png);
  if (chunks?.header.length !== HEADER_BYTES) return false;
  const { header, pixels } = chunks;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const depth = header[8];
  const format = FORMATS[header[9]];
  // interlacing is refused rather than walked: seven passes for a file nobody exports as a logo
  if (!format?.depths.includes(depth) || header[12] !== 0 || !width || !height) return false;
  const rowBytes = Math.ceil((width * format.channels * depth) / 8) + 1; // + the row's filter byte
  const totalBytes = rowBytes * height;
  return totalBytes <= MAX_PIXEL_BYTES && hasValidRows(pixels, rowBytes, totalBytes);
}

/** A file pdfkit would treat as a PNG and must not be given. Anything else fails synchronously. */
export const isDamagedPng = (file: Buffer) =>
  file.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC) && !isSoundPng(file);

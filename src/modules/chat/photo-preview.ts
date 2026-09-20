/**
 * **The small picture a photo is shown by** (chat.md §6.2).
 *
 * The browser draws it, not the server: a chat full of photos would otherwise mean the server
 * decoding images people sent it, which is a large attack surface for a thumbnail. Here the image
 * is decoded by the same engine that will draw it on the screen, and what leaves is a small JPEG.
 *
 * It fails quietly. A format this browser cannot decode — HEIC outside Safari is the one that
 * matters — draws nothing, and the photo is sent as a file card instead.
 */

/** At most this on the longest side (§6.2). */
export const PREVIEW_MAX = 320;
const QUALITY = 0.72;

/** What a browser may be able to draw. HEIC is here because Safari can, and nothing else does. */
const PHOTOS: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
]);

export const looksLikeAPhoto = (type: string) => PHOTOS.has(type.toLowerCase());

/** The size a picture is drawn at: never bigger than it was, never past the longest side. */
export function fitInto(width: number, height: number, max = PREVIEW_MAX) {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export async function drawPreview(file: File): Promise<Blob | null> {
  if (!looksLikeAPhoto(file.type)) return null;
  if (typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const { width, height } = fitInto(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", QUALITY),
    );
  } catch {
    // a format this browser cannot decode: the photo goes as a card, which is the rule (§6.2)
    return null;
  } finally {
    bitmap?.close();
  }
}

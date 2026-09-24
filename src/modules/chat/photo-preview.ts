/**
 * **The small picture a photo is shown by** (chat.md §6.2).
 *
 * The browser draws it, not the server: a chat full of photos would otherwise mean the server
 * decoding images people sent it, which is a large attack surface for a thumbnail. Here the image
 * is decoded by the same engine that will draw it on the screen, and what leaves is a small JPEG.
 *
 * **It is drawn for a retina screen** (owner, 2026-09-20: "превью — воно якесь не чітке"). The
 * first version drew 320 px and the bubble showed it 420 px wide on a 2× display, so every photo
 * was a four-times upscale of a small JPEG. The longest side is 960 px now, which is 480 CSS px at
 * 2× — wider than a bubble ever gets — and the bubble no longer stretches a preview past its own
 * size. The cost is bytes, so the drawing steps its quality, and then its size, down until it fits
 * the budget below; a photograph lands at the first step, a dense screenshot a step or two later.
 *
 * It fails quietly. A format this browser cannot decode — HEIC outside Safari is the one that
 * matters — draws nothing, and the photo is sent as a file card instead.
 */

/** At most this on the longest side (§6.2). */
export const PREVIEW_MAX = 960;

/** What the drawing aims to stay under; the server refuses at twice this, which is the margin. */
export const PREVIEW_BUDGET = 400 * 1024;

/** `PREVIEW_MAX_BYTES` in `server/modules/chat/chat.files.ts`: past it the upload is refused. */
const SERVER_REFUSES_PAST = 800 * 1024;

/** Tried in order until one fits the budget: quality first, then size, so sharpness goes last. */
const STEPS: readonly { max: number; quality: number }[] = [
  { max: PREVIEW_MAX, quality: 0.82 },
  { max: PREVIEW_MAX, quality: 0.68 },
  { max: 720, quality: 0.68 },
  { max: 560, quality: 0.6 },
];

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

const draw = (bitmap: ImageBitmap, max: number, quality: number): Promise<Blob | null> => {
  const { width, height } = fitInto(bitmap.width, bitmap.height, max);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  ctx.imageSmoothingQuality = "high";
  /**
   * **White under it, because a JPEG has no transparency.**
   *
   * A fresh canvas is transparent black, and `toBlob(…, "image/jpeg")` has nowhere to put an alpha
   * channel — so every transparent pixel came out BLACK. A logo on a transparent background, which
   * is what most logos are, arrived in the chat as a black rectangle while the full-size picture
   * opened perfectly in the viewer. Found on the first day in production, on the firm's own logo
   * (owner, 2026-09-24).
   *
   * White rather than the page's colour: it is what the viewer shows a picture on, what a
   * screenshot of a document assumes, and the only choice that does not change when somebody
   * turns on a dark theme.
   */
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
};

export async function drawPreview(file: File): Promise<Blob | null> {
  if (!looksLikeAPhoto(file.type)) return null;
  if (typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    let last: Blob | null = null;
    for (const step of STEPS) {
      last = await draw(bitmap, step.max, step.quality);
      if (!last) return null;
      if (last.size <= PREVIEW_BUDGET) return last;
    }
    // the last step is the smallest this draws; a little over the budget still beats no picture,
    // but past what the server takes the whole upload would be refused, and a photo sent as a
    // card is a far better answer than a photo not sent at all
    return last && last.size <= SERVER_REFUSES_PAST ? last : null;
  } catch {
    // a format this browser cannot decode: the photo goes as a card, which is the rule (§6.2)
    return null;
  } finally {
    bitmap?.close();
  }
}

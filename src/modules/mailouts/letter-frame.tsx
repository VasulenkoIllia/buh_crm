import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The letter, at its own height — so the whole thing is readable in one pass.
 *
 * A fixed-height iframe gives the letter its own inner scrollbar inside a modal that already
 * scrolls: two nested scroll areas, and the reader has to hunt for the footer. Measuring the
 * content and growing to fit removes the inner one entirely.
 *
 * `sandbox="allow-same-origin"` rather than a bare `sandbox`: the height can only be read from a
 * same-origin document. Scripts, forms, popups and navigation all stay blocked, and the HTML is
 * ours in the first place.
 *
 * Shared by both previews — the composer's "who gets this" and the editor's "what does this look
 * like". They showed the same letter at two different heights before this was one component.
 *
 * On a phone the frame is narrower than the letter can go: the contact pills sit in one row that
 * does not wrap, so the letter stops shrinking at about 490px and the frame cut off its right side.
 * A mail app on a phone shrinks such a letter to the screen, so the frame does the same: it lays
 * the letter out at the narrowest width it takes and scales that down to the frame. Where the
 * letter fits, as on a desktop, the scale is 1 and the frame is what it always was. The letter
 * itself is left alone, because it is exactly what the client receives.
 */
export function LetterFrame({ html, min = 420 }: { html: string; min?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(min);
  // the width the letter is laid out at when it does not fit the frame; 0 while it fits
  const [layoutWidth, setLayoutWidth] = useState(0);
  const [scale, setScale] = useState(1);

  const measure = useCallback(() => {
    const doc = ref.current?.contentDocument;
    const frameWidth = box.current?.clientWidth;
    if (!doc?.body || !frameWidth) return;
    const narrowest = narrowestWidth(doc.body);
    const fits = narrowest <= frameWidth;
    setLayoutWidth(fits ? 0 : narrowest);
    setScale(fits ? 1 : frameWidth / narrowest);
    // The root element's own box, not the body: the body has margin collapsing that reports a few
    // pixels short and reintroduces a scrollbar for exactly one line. And its box, not its
    // `scrollHeight`, which never drops below the frame's current height: once the frame resizes,
    // a letter that got shorter would keep a blank strip under its footer. Rounded as
    // `scrollHeight` rounds, so a letter that fits keeps its height to the pixel
    const content = Math.round(doc.documentElement.getBoundingClientRect().height);
    setHeight(Math.max(min, content, doc.body.scrollHeight));
  }, [min]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame || !box.current) return;

    measure();
    frame.addEventListener("load", measure);
    // the letterhead settles after load and changes the height
    const timer = window.setTimeout(measure, 250);
    // the frame's width (a turned phone, a resized window), and the letter's height once it is
    // laid out at a new width
    const resize = new ResizeObserver(measure);
    resize.observe(box.current);
    resize.observe(frame);
    return () => {
      frame.removeEventListener("load", measure);
      window.clearTimeout(timer);
      resize.disconnect();
    };
  }, [html, measure]);

  const scaled = layoutWidth > 0;
  return (
    <div
      ref={box}
      // +2: the border, which the box's height includes
      style={{ height: Math.ceil(height * scale) + 2 }}
      className="overflow-hidden rounded-(--radius-field) border border-border bg-white"
    >
      <iframe
        ref={ref}
        title="The letter as it will arrive"
        sandbox="allow-same-origin"
        srcDoc={html}
        style={
          scaled
            ? {
                width: layoutWidth,
                height,
                transform: `scale(${scale})`,
                transformOrigin: "0 0",
              }
            : { height }
        }
        className={scaled ? "border-0" : "w-full border-0"}
      />
    </div>
  );
}

/**
 * The narrowest width the letter lays out at with nothing sticking out: its body, briefly sized to
 * its own min-content. Set and put back in one go, before the browser paints. The body's margin is
 * not counted, which holds because the letter's body has none (`email-layout.ts`); rounded up, as
 * a width a fraction short would push the pill row past the edge after all.
 */
function narrowestWidth(body: HTMLElement): number {
  const before = body.style.width;
  body.style.width = "min-content";
  const width = Math.max(body.scrollWidth, Math.ceil(body.getBoundingClientRect().width));
  body.style.width = before;
  return width;
}

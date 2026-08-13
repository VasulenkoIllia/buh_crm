import { useEffect, useRef, useState } from "react";

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
 */
export function LetterFrame({ html, min = 420 }: { html: string; min?: number }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(min);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;

    const measure = () => {
      const doc = frame.contentDocument;
      if (!doc?.body) return;
      // `scrollHeight` on the element, not the body: the body has margin collapsing that reports a
      // few pixels short and reintroduces a scrollbar for exactly one line
      setHeight(Math.max(min, doc.documentElement.scrollHeight, doc.body.scrollHeight) + 2);
    };

    measure();
    frame.addEventListener("load", measure);
    // the letterhead settles after load and changes the height
    const timer = window.setTimeout(measure, 250);
    return () => {
      frame.removeEventListener("load", measure);
      window.clearTimeout(timer);
    };
  }, [html, min]);

  return (
    <iframe
      ref={ref}
      title="The letter as it will arrive"
      sandbox="allow-same-origin"
      srcDoc={html}
      style={{ height }}
      className="w-full rounded-(--radius-field) border border-border bg-white"
    />
  );
}

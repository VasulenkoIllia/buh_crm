import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { cn } from "@/shared/lib/cn";

/**
 * An (i) that holds a sentence or two of REFERENCE — something true, worth having once, and not
 * worth a paragraph on every visit.
 *
 * **What does NOT belong in here** (decision 2026-08-27, with the audit that produced it):
 *
 * - a RULE the form does not enforce for you. Hidden, it is learned from a rejection instead of
 *   read before the mistake. A rule the CONTROL already enforces is different — see below;
 * - a CONSEQUENCE that only shows up later ("a part-served period isn't invoiced automatically —
 *   you'll get a reminder task"). Hidden, it becomes a surprise a month afterwards;
 * - anything DYNAMIC ("Showing 12 of 40", "Part payment — $80 would still be owed"). That is the
 *   screen's state, not its documentation, and belongs on the screen.
 *
 * Hidden text is unread text. That is the whole point of the control and also its only danger.
 *
 * **Amended 2026-08-28 (user).** The four-line block on "Service starts on" moved in here, and it
 * carries both a rule and a consequence — the two kinds listed above. It was the largest thing in
 * a form asked to be compact, and it explained one field while floating under the whole row. The
 * rule half is safe to hide because the picker enforces it: `min={todayIso()}` means a backdated
 * start cannot be typed, so nobody learns it from a rejection. The consequence half is the real
 * cost of this decision and is recorded as such.
 *
 * Opens on hover AND on click, and is reachable from the keyboard — a hover-only tooltip does not
 * exist for anyone on a touch screen or navigating by Tab, and `title=` (which this app uses for
 * row-action labels) is unstyled, delayed by about a second and wraps long text badly.
 */

/** how far the panel keeps from the window's edges */
const MARGIN = 8;
/** the gap between the icon and the panel */
const OFFSET = 6;
const WIDTH = 280;

export function InfoHint({
  children,
  label = "More information",
  className,
}: {
  children: ReactNode;
  /** what the icon announces to a screen reader before the hint itself is read out */
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLSpanElement>(null);

  /**
   * Positioned from the viewport, in a portal on `document.body`.
   *
   * It cannot live beside the icon: every place this control is used sits inside something that
   * scrolls — a modal body is `overflow-y-auto`, and an overflow other than `visible` clips its
   * descendants on BOTH axes however they are positioned. The panel was simply cut off at the
   * modal's edge (user, 2026-08-27).
   *
   * Below the icon and aligned to its left by default; pulled back when it would cross the right
   * edge, and flipped above when there is no room below. Recomputed on scroll and resize because
   * `fixed` does not follow the icon when the modal body scrolls under it.
   */
  const place = useCallback(() => {
    const b = button.current?.getBoundingClientRect();
    if (!b) return;
    const width = panel.current?.offsetWidth ?? WIDTH;
    const height = panel.current?.offsetHeight ?? 0;
    const left = Math.max(MARGIN, Math.min(b.left, window.innerWidth - width - MARGIN));
    const below = b.bottom + OFFSET;
    const fitsBelow = below + height <= window.innerHeight - MARGIN;
    setAt({ top: fitsBelow ? below : Math.max(MARGIN, b.top - OFFSET - height), left });
  }, []);

  useEffect(() => {
    if (!open) {
      setAt(null);
      return;
    }
    place();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape belongs to the innermost open thing. This listens on `document` and a modal
      // listens on `window` — document comes first in the bubble path, so without stopping here
      // both closed on one press, and reading a hint threw away a half-filled form
      // (user, 2026-08-28).
      e.stopPropagation();
      setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    // `capture` so an inner scroller (the modal body, a list box) is heard, not just the window
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, place]);

  // measured once it exists, so the flip and the clamp use the real height rather than a guess
  useEffect(() => {
    if (open && at === null) place();
  }, [open, at, place]);

  return (
    <span
      ref={wrap}
      className={cn("relative inline-flex align-middle", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        className="flex h-4 w-4 items-center justify-center rounded-full text-[#b6bcc5] transition-colors hover:text-primary-link focus-visible:text-primary-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        onClick={() => setOpen((v) => !v)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <Info size={14} strokeWidth={2} />
      </button>
      {open &&
        createPortal(
          <span
            ref={panel}
            id={id}
            role="tooltip"
            style={{ top: at?.top ?? 0, left: at?.left ?? 0, width: WIDTH }}
            className={cn(
              "fixed z-[60] rounded-(--radius-field) border border-border bg-surface px-2.5 py-2",
              "text-[12px] font-normal normal-case leading-snug tracking-normal text-ink-700",
              "shadow-(--shadow-card)",
              // measured before it is seen, so it never flashes in the top-left corner first
              at === null && "invisible",
            )}
          >
            {children}
          </span>,
          document.body,
        )}
    </span>
  );
}

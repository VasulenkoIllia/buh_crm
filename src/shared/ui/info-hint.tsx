import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { cn } from "@/shared/lib/cn";

/**
 * An (i) that holds a sentence or two of REFERENCE — something true, worth having once, and not
 * worth a paragraph on every visit.
 *
 * **What does NOT belong in here** (decision 2026-08-27, with the audit that produced it):
 *
 * - a RULE that constrains what may be typed ("today or a future date"). Hidden, it is learned
 *   from a rejection instead of read before the mistake;
 * - a CONSEQUENCE that only shows up later ("a part-served period isn't invoiced automatically —
 *   you'll get a reminder task"). Hidden, it becomes a surprise a month afterwards;
 * - anything DYNAMIC ("Showing 12 of 40", "Part payment — $80 would still be owed"). That is the
 *   screen's state, not its documentation, and belongs on the screen.
 *
 * Hidden text is unread text. That is the whole point of the control and also its only danger.
 *
 * Opens on hover AND on click, and is reachable from the keyboard — a hover-only tooltip does not
 * exist for anyone on a touch screen or navigating by Tab, and `title=` (which this app uses for
 * row-action labels) is unstyled, delayed by about a second and wraps long text badly.
 */
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
  const id = useId();
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // a click anywhere else closes it — the same way every other transient panel here behaves
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <span
      ref={box}
      className={cn("relative inline-flex align-middle", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
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
      {open && (
        <span
          id={id}
          role="tooltip"
          // left-aligned to the icon and above everything else in a modal; `w-max` with a cap keeps
          // a short hint short instead of stretching it to a fixed panel
          className="absolute left-0 top-[calc(100%+6px)] z-50 w-max max-w-[280px] rounded-(--radius-field) border border-border bg-surface px-2.5 py-2 text-[12px] leading-snug font-normal normal-case tracking-normal text-ink-700 shadow-(--shadow-card)"
        >
          {children}
        </span>
      )}
    </span>
  );
}

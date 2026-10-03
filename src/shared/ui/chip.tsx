import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { CHIP_TONES, type ChipTone } from "@/shared/lib/colors";
import { cn } from "@/shared/lib/cn";
import { FOCUS } from "./button";

/** The shape both wear, so the chip that states a fact and the one that changes it cannot drift. */
const SHAPE = "inline-flex items-center rounded-(--radius-chip) text-[11px]";
const PAD = { sm: "px-[6px] py-[1px]", md: "px-2 py-[2px]" } as const;

type Size = keyof typeof PAD;

/**
 * A small inline status chip (auto / invoice / included / unbilled …). Tone picks
 * one of the neutral semantic color pairs; `strong` bumps the weight (e.g. invoice
 * numbers). Pass extra classes (e.g. `capitalize`) via className.
 */
export function Chip({
  tone,
  strong,
  size = "md",
  title,
  className,
  children,
}: {
  tone: ChipTone;
  strong?: boolean;
  /** `sm` = tighter padding for dense rollup rows; `md` (default) for cards & modals */
  size?: Size;
  /** hover explanation — a chip is terse by design, the rule behind it often isn't */
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const c = CHIP_TONES[tone];
  return (
    <span
      className={cn(SHAPE, PAD[size], strong && "font-medium", className)}
      title={title}
      style={{ color: c.fg, backgroundColor: c.bg }}
    >
      {children}
    </span>
  );
}

export interface ChipButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** paint it like the chip beside it; omit for a value that should look untouched at rest */
  tone?: ChipTone;
  strong?: boolean;
  size?: Size;
}

/**
 * **A chip you can press.** `Chip` states a fact; this one states it and is also the way to change
 * it — the board card's assignee, which until 2026-10-03 could only be set by opening the task.
 *
 * It is a chip's size and not a button's on purpose. The card's row of facts is 20px of 11px text
 * and the smallest `Button` is 28px tall, so a real button there would set the row's height and
 * push the card's own two acts down. Everything else a control owes it still has: the one focus
 * ring, imported from `button.tsx` rather than written again, a disabled state, one line of text.
 *
 * Without a `tone` it is transparent at rest and shows only a hover — for a value that should look
 * exactly as it did before anybody could press it.
 */
export const ChipButton = forwardRef<HTMLButtonElement, ChipButtonProps>(
  ({ tone, strong, size = "md", type, className, ...props }, ref) => {
    const c = tone ? CHIP_TONES[tone] : null;
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={cn(
          SHAPE,
          PAD[size],
          "max-w-full gap-1 whitespace-nowrap transition-colors",
          "disabled:pointer-events-none disabled:opacity-50",
          // a toned chip darkens where a transparent one has to grow a background to show anything
          c ? "hover:brightness-95" : "text-muted hover:bg-divider hover:text-ink",
          strong && "font-medium",
          FOCUS,
          className,
        )}
        style={c ? { color: c.fg, backgroundColor: c.bg } : undefined}
        {...props}
      />
    );
  },
);
ChipButton.displayName = "ChipButton";

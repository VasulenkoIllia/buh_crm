import type { ReactNode } from "react";
import { CHIP_TONES, type ChipTone } from "@/shared/lib/colors";
import { cn } from "@/shared/lib/cn";

/**
 * A small inline status chip (auto / invoice / included / unbilled …). Tone picks
 * one of the neutral semantic color pairs; `strong` bumps the weight (e.g. invoice
 * numbers). Pass extra classes (e.g. `capitalize`) via className.
 */
export function Chip({
  tone,
  strong,
  size = "md",
  className,
  children,
}: {
  tone: ChipTone;
  strong?: boolean;
  /** `sm` = tighter padding for dense rollup rows; `md` (default) for cards & modals */
  size?: "sm" | "md";
  className?: string;
  children: ReactNode;
}) {
  const c = CHIP_TONES[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-(--radius-chip) text-[11px]",
        size === "sm" ? "px-[6px] py-[1px]" : "px-2 py-[2px]",
        strong && "font-medium",
        className,
      )}
      style={{ color: c.fg, backgroundColor: c.bg }}
    >
      {children}
    </span>
  );
}

import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

/**
 * A bordered, vertically scrolling list box.
 *
 * The reason it exists is the `stable` flag. A box capped with `max-height` grows and shrinks with
 * what it holds, which is fine until something FILTERS it — then every keystroke resizes the box,
 * and everything below it jumps up and down the screen while you are still typing (user,
 * 2026-08-27). A list under a search field has to keep its height.
 *
 * `stable` and "there is a filter" are the same condition, so they are decided together at the call
 * site: a list nobody can narrow should still hug its contents rather than sit half empty.
 *
 * The height is a NUMBER and lands in a style attribute rather than a Tailwind class, because
 * Tailwind's JIT only sees literal class names and `h-[${n}px]` would silently produce nothing.
 */
export function ScrollBox({
  height,
  stable = false,
  className,
  children,
}: {
  /** in pixels — the height when `stable`, the cap when not */
  height: number;
  /** keep this height whatever it holds — for a list something filters */
  stable?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      style={stable ? { height } : { maxHeight: height }}
      className={cn(
        "overflow-y-auto rounded-(--radius-field) border border-border",
        className,
      )}
    >
      {children}
    </div>
  );
}

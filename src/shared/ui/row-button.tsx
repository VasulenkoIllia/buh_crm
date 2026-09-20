import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/shared/lib/cn";

/**
 * **A whole row that is a control** — a chat in the list, a search hit, a file, a client to pick,
 * a place to move a secret into. Twenty-six of these were hand-rolled across the modules, each
 * with its own padding, hover and selected colour (audit, 2026-09-20), which is why one row of
 * results looked different from the next.
 *
 * It is `w-full text-left` by design: a row is the width of what holds it, and its text starts
 * where the text above it starts. Everything else is the caller's, through `className` — a row in
 * a sidebar is not padded like a row in a modal.
 */
export const RowButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    /** the one being looked at: the search's current hit, the place already chosen */
    selected?: boolean;
  }
>(({ className, selected, type, ...props }, ref) => (
  <button
    ref={ref}
    type={type ?? "button"}
    aria-current={selected ? "true" : undefined}
    className={cn(
      "flex w-full items-center gap-2 text-left transition-colors",
      "outline-none focus-visible:bg-divider focus-visible:ring-2 focus-visible:ring-primary/45",
      "disabled:pointer-events-none disabled:opacity-50",
      selected ? "bg-divider" : "hover:bg-divider/60",
      className,
    )}
    {...props}
  />
));
RowButton.displayName = "RowButton";

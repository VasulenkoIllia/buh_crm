import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/shared/lib/cn";

/**
 * **The one focus ring.** Until 2026-09-20 `focus-visible` appeared three times in the whole of
 * `src/`, and neither of these two components had it: somebody moving through the CRM with a
 * keyboard could not see where they were. It is here, once, so every control that goes through
 * these gets it and nothing has to remember.
 */
const FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-primary/45 focus-visible:ring-offset-1";

/**
 * **An icon inside a control is sized by the control**, not by the call site. There were twenty
 * different icon sizes in the modules and two ways of writing them (a `size` prop and a class), so
 * the same action was 13, 14, 15 or 16 pixels depending on who wrote it. CSS wins over the SVG's
 * own width attribute, so this settles it without touching the two hundred call sites that pass a
 * size — and new code passes none.
 */
const ICON = "[&_svg]:shrink-0";

const buttonVariants = cva(
  cn(
    "inline-flex items-center justify-center gap-1.5 rounded-(--radius-field) text-[13px]",
    "font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
    FOCUS,
    ICON,
    "[&_svg]:size-[14px]",
  ),
  {
    variants: {
      variant: {
        primary: "bg-primary text-white hover:bg-link-hover",
        secondary: "border border-border bg-surface text-ink hover:bg-divider",
        positive: "bg-success text-white hover:opacity-90",
        destructive: "bg-danger text-white hover:opacity-90",
        text: "text-primary-link hover:text-link-hover hover:underline",
      },
      size: {
        sm: "h-7 px-2.5 rounded-(--radius-btn-sm)",
        md: "h-9 px-3.5",
        lg: "h-10 px-5",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type, ...props }, ref) => (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** what the icon means — becomes the tooltip AND the accessible name */
  label: string;
  /**
   * A destructive action: red on HOVER, never at rest. A row of red icons makes a list look like a
   * list of problems. Written as a prop rather than as `className="hover:text-danger"` at each
   * site, because four different spellings of that class were in use (audit, 2026-09-20).
   */
  danger?: boolean;
  /** `md` (28px) is a row action; `sm` (24px) is for a dense bar, a chip, a search field */
  size?: "sm" | "md";
}

/**
 * THE row action. Every per-row Edit / Delete / toggle in a list or table is one of these —
 * 28×28, grey at rest — and nothing hand-rolls another (user, 2026-07-30). Text links are for
 * navigation, disclosure, and wide form-spanning actions; a control that acts on THIS row is an icon.
 *
 * Text links here wrapped to two lines in a narrow Actions column, and four repeated words per row
 * ("Edit · Make default · Deactivate · Delete") pulled the eye off the data the row is about.
 *
 * `label` is required and becomes BOTH `title` and `aria-label` — an icon-only control without a
 * tooltip is a riddle, and without an accessible name it doesn't exist to a screen reader. Say what
 * the click DOES in the current state ("Default for new clients — click to clear"), not what it is.
 *
 * No `disabled:pointer-events-none` on purpose: a disabled action must still show its tooltip,
 * which is where the "why not" lives (e.g. "clear the default first"). A toggle shows its state in
 * the icon itself (filled + brand blue when on). Full rules: docs/design-system.md.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, title, className, type, danger, size = "md", ...props }, ref) => (
    <button
      ref={ref}
      type={type ?? "button"}
      title={title ?? label}
      aria-label={label}
      className={cn(
        "inline-flex flex-none items-center justify-center rounded-(--radius-btn-sm)",
        "text-muted transition-colors hover:bg-divider disabled:opacity-50",
        size === "sm" ? "h-6 w-6 [&_svg]:size-[14px]" : "h-7 w-7 [&_svg]:size-[15px]",
        danger ? "hover:text-danger" : "hover:text-ink",
        FOCUS,
        ICON,
        className,
      )}
      {...props}
    />
  ),
);
IconButton.displayName = "IconButton";

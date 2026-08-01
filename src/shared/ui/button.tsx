import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/shared/lib/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-(--radius-field) text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
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
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

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
 * which is where the "why not" lives (e.g. "clear the default first"). Destructive actions pass
 * `className="hover:text-danger"` — red on hover only, never at rest. A toggle shows its state in
 * the icon itself (filled + brand blue when on). Full rules: docs/design-system.md.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, title, className, type, ...props }, ref) => (
    <button
      ref={ref}
      type={type ?? "button"}
      title={title ?? label}
      aria-label={label}
      className={cn(
        "inline-flex h-7 w-7 flex-none items-center justify-center rounded-(--radius-btn-sm)",
        "text-muted transition-colors hover:bg-divider hover:text-ink disabled:opacity-40",
        className,
      )}
      {...props}
    />
  ),
);
IconButton.displayName = "IconButton";

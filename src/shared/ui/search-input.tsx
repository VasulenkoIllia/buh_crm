import type { InputHTMLAttributes } from "react";
import { cn } from "@/shared/lib/cn";

/**
 * The search box that sits in a screen's HEADER — Clients, Billing, Archive, the services catalog.
 *
 * Deliberately not `Input` from `field.tsx`. That one is a form control: a label beside it, the
 * field radius, a focus ring. This one lives in a header row next to the title and a count, and
 * the two have looked different since the first screen. What actually existed before this file
 * was the same markup pasted twice, which is how the two boxes ended up different widths
 * (`w-72` on Clients, `w-64` on Billing) with nobody deciding that (2026-08-31).
 *
 * Width is the one thing a caller sets, through `className` — `cn` runs tailwind-merge, so a
 * passed `w-64` replaces the default rather than fighting it.
 *
 * `type="search"` gives the browser's own clear button, which is what the catalog picker inside a
 * client's card has always used; a header search that could only be cleared by holding backspace
 * was the odd one out.
 */
export function SearchInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="search"
      className={cn(
        "w-72 rounded-(--radius-card) border border-[#d9dde3] bg-surface px-3 py-2 text-[13px]",
        "outline-none placeholder:text-faint focus:border-primary",
        className,
      )}
      {...props}
    />
  );
}

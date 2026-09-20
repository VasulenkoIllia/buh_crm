import { X } from "lucide-react";
import { cn } from "@/shared/lib/cn";

/**
 * **The × inside a field or a chip** — clear this box, drop this attachment, take this row out of
 * a list being edited. Eight of these were written as the typographic character `×` and twenty-two
 * as the icon, both meaning the same thing and in two sizes (audit, 2026-09-20).
 *
 * It is not `IconButton`: that one is 28px with a hover background, made to stand in a row of
 * actions, and this one sits INSIDE something — it has to be small and quiet enough not to fight
 * the field it is in.
 *
 * `label` says what goes away, not "close": a screen reader hears "Remove Petrenko" and not "×".
 */
export function ClearButton({
  label,
  onClick,
  className,
  disabled,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex size-4 flex-none items-center justify-center rounded-full",
        "text-faint transition-colors hover:bg-divider hover:text-ink disabled:opacity-50",
        "outline-none focus-visible:ring-2 focus-visible:ring-primary/45",
        className,
      )}
    >
      <X className="size-3" />
    </button>
  );
}

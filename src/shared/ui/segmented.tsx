import { cn } from "@/shared/lib/cn";

/**
 * **One choice out of two or three, side by side.** A filter that is a state rather than a list,
 * a unit, a yes/no/inherit.
 *
 * It had two hand-rolled clones — Settings → Access and the notification preferences — with three
 * different sizes, three radii and three ideas of what "selected" looks like (audit, 2026-09-20).
 * What they needed and this did not have is here now: a smaller size, a disabled whole, a per-option
 * tooltip, and a `quiet` option for a choice that means "whatever the rule says" rather than a
 * choice of its own — that one is grey when selected, because it is not an opinion.
 */
export function Segmented<T extends string | boolean | null>({
  value,
  onChange,
  options,
  size = "md",
  disabled,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: {
    value: T;
    label: string;
    /** why somebody would pick it; shown on hover */
    title?: string;
    /** "follow the rule", not an opinion: grey when selected rather than the primary blue */
    quiet?: boolean;
  }[];
  /** `sm` is for a dense table cell; `md` fills the width it is given */
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex rounded-(--radius-field) bg-[#eef0f3] p-0.5",
        size === "md" && "flex w-full gap-1.5",
        disabled && "opacity-50",
        className,
      )}
    >
      {options.map((opt) => (
        <button
          key={String(opt.value)}
          type="button"
          disabled={disabled}
          title={opt.title}
          onClick={() => onChange(opt.value)}
          className={cn(
            // `whitespace-nowrap`: a two-word option wrapped onto two lines makes the whole
            // control twice as tall and reads as a mistake
            "whitespace-nowrap rounded-(--radius-btn-sm) font-medium transition-colors",
            "outline-none focus-visible:ring-2 focus-visible:ring-primary/45",
            size === "sm" ? "px-2 py-[3px] text-[11px]" : "flex-1 px-3 py-1.5 text-[13px]",
            value === opt.value
              ? opt.quiet
                ? "bg-[#e0e4ea] text-ink-700"
                : // the same primary blue every other tab uses (see shared/ui/tabs.tsx)
                  "bg-primary text-white shadow-(--shadow-card)"
              : "text-muted hover:text-ink disabled:hover:text-muted",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

import type { ComponentType } from "react";
import { cn } from "@/shared/lib/cn";

/**
 * The app's two tab shapes. Both mark the active one in the PRIMARY blue — the project had
 * six different active looks (dark `bg-ink`, white-on-grey, blue solid, two blue underlines,
 * a light-blue chip), which made "selected" mean something different on every screen.
 *
 *   <Tabs>        — section navigation inside a page (client card, Services). Underline.
 *   <FilterChips> — narrowing a list (Tasks, Billing, Clients, invoice rollups). Solid chip.
 *
 * Form option pills (deadline presets, rhythm days) stay `pillCls` — those pick a VALUE,
 * they don't switch what the screen is showing.
 */

export interface TabOption<T extends string> {
  value: T;
  label: string;
  /** badge after the label (counts) — `undefined` renders no badge, `0` does */
  count?: number;
  icon?: ComponentType<{ size?: number; strokeWidth?: number }>;
  /** draw attention while INACTIVE (Billing's overdue chip) */
  tone?: "danger";
}

/** Underline tabs — navigation between sections of one screen. */
export function Tabs<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: TabOption<T>[];
  className?: string;
}) {
  return (
    <div className={cn("flex gap-1 border-b border-border", className)}>
      {options.map((o) => {
        const active = value === o.value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "-mb-px flex items-center gap-2 border-b-2 px-3.5 pb-2.5 pt-1.5 text-[13px] font-medium transition-colors",
              active
                ? "border-primary text-primary-link"
                : "border-transparent text-muted hover:text-ink",
            )}
          >
            {Icon && <Icon size={15} strokeWidth={2} />}
            {o.label}
            {o.count !== undefined && (
              <span
                className={cn(
                  "rounded-full px-1.5 py-px text-[11px] font-semibold tabular-nums",
                  active ? "bg-primary/10 text-primary-link" : "bg-divider text-muted",
                )}
              >
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Chip row — which slice of a list is on screen. */
export function FilterChips<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: TabOption<T>[];
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "whitespace-nowrap rounded-(--radius-field) px-3 py-1.5 text-[13px] font-medium transition-colors",
              active
                ? "bg-primary text-white"
                : "border border-border bg-surface text-ink-700 hover:bg-divider",
              // an inactive chip that has something worth looking at (overdue invoices)
              !active && o.tone === "danger" && o.count ? "text-danger-text" : "",
            )}
          >
            {o.label}
            {o.count !== undefined && (
              <span
                className={cn(
                  "ml-1.5 rounded-full px-1.5 py-px text-[11px] font-semibold tabular-nums",
                  active ? "bg-white/20 text-white" : "bg-divider text-muted",
                )}
              >
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

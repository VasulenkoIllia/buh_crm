import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/shared/lib/cn";
import { Input } from "@/shared/ui/field";

export interface SearchOption {
  value: string;
  label: string;
  /** shown after the label in a lighter tone (e.g. "(inactive)") */
  hint?: string;
}

/**
 * A single-select you can type into — the same feel as the task form's client search, but over
 * a list that's already loaded (services, sources): filtering happens in memory, no request.
 *
 * A plain `<select>` is fine for five options and useless for fifty; this keeps the picked value
 * visible in the field, opens its list on focus, filters as you type, and clears with ×.
 */
export function SearchSelect({
  id,
  value,
  options,
  placeholder = "Search…",
  emptyLabel = "—",
  ariaLabel,
  disabled,
  emptyAction,
  onChange,
}: {
  id?: string;
  /** the selected option's value, or "" for none */
  value: string;
  options: SearchOption[];
  placeholder?: string;
  /** the "nothing selected" row at the top of the list */
  emptyLabel?: string;
  /** for fields with no visible <label> (a row in a repeating editor) */
  ariaLabel?: string;
  /** nothing to pick from yet (e.g. no client chosen) — say so in the placeholder too */
  disabled?: boolean;
  /**
   * A way forward when what was typed matches nothing — offered instead of "No matches". It
   * receives the phrase, so the screen it opens can carry the search rather than ask for it
   * twice. Omitted wherever the dead end is the honest answer.
   */
  emptyAction?: { label: string; onSelect: (query: string) => void };
  onChange: (value: string) => void;
}) {
  const selected = options.find((o) => o.value === value) ?? null;
  const [query, setQuery] = useState(selected?.label ?? "");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // The list is portalled to <body> and positioned against the field. Every use of this control
  // so far sits inside a modal whose body scrolls, and an absolutely-positioned list there gets
  // clipped by that scroll container (or worse, silently extends it). Fixed coordinates escape
  // the container entirely, and flip above the field when there isn't room below.
  const [rect, setRect] = useState<{
    left: number;
    width: number;
    /** viewport coords of the field itself — the list hangs off one edge or the other */
    fieldTop: number;
    fieldBottom: number;
    drop: "down" | "up";
  } | null>(null);

  const LIST_MAX = 224; // max-h-56

  const place = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    setRect({
      left: r.left,
      width: r.width,
      fieldTop: r.top,
      fieldBottom: r.bottom,
      // only flip up when below is too tight AND above is genuinely roomier
      drop: below < LIST_MAX && r.top > below ? "up" : "down",
    });
  }, []);

  // keep the field in step when the value changes from outside (form reset, preset pick)
  useEffect(() => {
    setQuery(selected?.label ?? "");
  }, [selected?.label]);

  // position on open, and keep up with a scroll/resize underneath (fixed coords don't follow)
  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("scroll", place, true); // capture: any scrolling ancestor
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  // a click anywhere else commits what's selected and closes the list. The list lives in a
  // portal, so "outside" has to mean outside BOTH the field and the list.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (box.current?.contains(target) || list.current?.contains(target)) return;
      setOpen(false);
      setQuery(selected?.label ?? "");
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, selected?.label]);

  const typed = query.trim().toLowerCase();
  // showing the current pick isn't a search — list everything until they actually type
  const searching = typed.length > 0 && typed !== selected?.label.toLowerCase();
  const matches = searching
    ? options.filter((o) => o.label.toLowerCase().includes(typed))
    : options;

  const pick = (v: string) => {
    onChange(v);
    setQuery(options.find((o) => o.value === v)?.label ?? "");
    setOpen(false);
  };

  const rows: (SearchOption | null)[] = [null, ...matches]; // null = the "nothing" row
  // the moment the action earns its place: they typed, and this list has nothing to offer.
  // Holding the action itself rather than a boolean is what lets the uses below be type-checked.
  const offerAction = searching && matches.length === 0 ? emptyAction : undefined;

  return (
    <div className="relative" ref={box}>
      <Input
        id={id}
        className="pr-7"
        autoComplete="off"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        disabled={disabled}
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
          setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
          setHighlight(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            setHighlight((h) => {
              const next = e.key === "ArrowDown" ? h + 1 : h - 1;
              return Math.max(0, Math.min(rows.length - 1, next));
            });
          } else if (e.key === "Enter" && open) {
            e.preventDefault();
            // nothing to pick: Enter takes the way out rather than clearing what was typed
            if (offerAction) {
              setOpen(false);
              offerAction.onSelect(query.trim());
            } else pick(rows[highlight]?.value ?? "");
          } else if (e.key === "Escape" && open) {
            e.stopPropagation(); // don't close the whole modal, just the list
            setOpen(false);
            setQuery(selected?.label ?? "");
          }
        }}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-[14px] leading-none text-muted hover:text-ink"
          onClick={() => {
            onChange("");
            setQuery("");
          }}
        >
          ×
        </button>
      )}

      {open &&
        rect &&
        createPortal(
          <div
            ref={list}
            style={{
              position: "fixed",
              left: rect.left,
              width: rect.width,
              ...(rect.drop === "down"
                ? { top: rect.fieldBottom + 4 }
                : { bottom: window.innerHeight - rect.fieldTop + 4 }),
            }}
            className="z-50 max-h-56 overflow-y-auto rounded-(--radius-field) border border-border bg-surface py-1 shadow-(--shadow-modal)"
          >
            {rows.map((o, i) => (
              <button
                key={o?.value ?? "__none"}
                type="button"
                // mousedown, not click: blur would close the list before a click landed
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o?.value ?? "");
                }}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "block w-full px-3 py-1.5 text-left text-[13px]",
                  i === highlight ? "bg-divider" : "hover:bg-divider",
                  !o && "text-muted",
                )}
              >
                {o ? o.label : emptyLabel}
                {o?.hint && <span className="text-faint"> {o.hint}</span>}
              </button>
            ))}
            {searching && matches.length === 0 && (
              <p className="px-3 py-1.5 text-[13px] text-muted">No matches</p>
            )}
            {offerAction && (
              <button
                type="button"
                // mousedown, not click: blur would close the list before a click landed
                onMouseDown={(e) => {
                  e.preventDefault();
                  setOpen(false);
                  offerAction.onSelect(query.trim());
                }}
                className="block w-full border-t border-divider px-3 py-1.5 text-left text-[13px] font-medium text-primary-link hover:bg-divider"
              >
                {offerAction.label}
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

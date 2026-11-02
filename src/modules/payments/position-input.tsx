import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { itemPriceLabel, type InvoiceItem } from "@shared/schema/invoice-items";
import { cn } from "@/shared/lib/cn";
import { Input } from "@/shared/ui/field";

/** max-h-56, the list's own scroll beyond it */
const LIST_MAX_PX = 224;

/**
 * **The Position box** (payments.md §3): free text, with the invoice items whose names hold what
 * is typed offered under it. Picking one hands it to the row; typing on is a position by hand.
 *
 * Not `SearchSelect`: that one holds a choice and puts its label back over whatever was typed,
 * and here the typed text IS the value. Not a `<datalist>`: the browser's own list could not be
 * checked the same way everywhere, and its Escape closed the whole New invoice (2026-11-02).
 * Portalled and fixed, as SearchSelect's list is, because the rows scroll inside a modal that
 * would clip it.
 *
 * Nothing is highlighted until an arrow key says so, so Enter after typing keeps the text.
 */
export function PositionInput({
  value,
  items,
  pickedId,
  placeholder,
  onText,
  onPick,
}: {
  value: string;
  /** the items the picker may offer: active ones only */
  items: InvoiceItem[];
  /** the item the row came from, not offered again while the row still reads its name */
  pickedId: string | null;
  placeholder: string;
  onText: (text: string) => void;
  onPick: (item: InvoiceItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const field = useRef<HTMLInputElement>(null);
  const at = useFieldPlace(field, open);
  const listId = useId();
  const matches = open ? suggestions(items, value, pickedId) : [];
  const shown = at !== null && matches.length > 0;
  const active = Math.min(highlight, matches.length - 1);
  const optionId = (i: number) => `${listId}-${i}`;

  const show = () => {
    setOpen(true);
    setHighlight(-1);
  };
  const pick = (item: InvoiceItem) => {
    onPick(item);
    setOpen(false);
  };

  return (
    <>
      <Input
        ref={field}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={shown ? listId : undefined}
        aria-activedescendant={shown && active >= 0 ? optionId(active) : undefined}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onFocus={show}
        // a second press on a box that still has the focus, after Escape or a pick
        onClick={() => {
          if (!open) show();
        }}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          onText(e.target.value);
          show();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !shown) {
            e.preventDefault();
            show();
          } else if (!shown) {
            return;
          } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const step = e.key === "ArrowDown" ? 1 : -1;
            const next = Math.max(0, Math.min(matches.length - 1, active + step));
            setHighlight(next);
            // the arrows, not the mouse, keep the highlighted row in sight past the list's edge
            document.getElementById(optionId(next))?.scrollIntoView({ block: "nearest" });
          } else if (e.key === "Enter" && active >= 0) {
            e.preventDefault();
            pick(matches[active]);
          } else if (e.key === "Escape") {
            // marked handled, so the modal around it stays open (shared/ui/modal.tsx)
            e.preventDefault();
            setOpen(false);
          }
        }}
      />
      {shown &&
        createPortal(
          <div
            id={listId}
            role="listbox"
            aria-label="Invoice items"
            // a press anywhere on the list, its scrollbar included, keeps the focus in the box,
            // so its blur does not close the list under the pointer
            onMouseDown={(e) => e.preventDefault()}
            style={{
              position: "fixed",
              left: at.left,
              width: Math.max(at.width, 240),
              ...(at.drop === "down"
                ? { top: at.bottom + 4 }
                : { bottom: window.innerHeight - at.top + 4 }),
            }}
            className="z-50 max-h-56 overflow-y-auto rounded-(--radius-field) border border-border bg-surface py-1 shadow-(--shadow-modal)"
          >
            {matches.map((item, i) => (
              <div
                key={item.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                // a click, which a screen reader's double tap also sends
                onClick={() => pick(item)}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex cursor-pointer items-baseline justify-between gap-3 px-3 py-1.5 text-[13px] max-sm:min-h-11 max-sm:items-center",
                  i === active && "bg-divider",
                )}
              >
                <span className="min-w-0 break-words">{item.name}</span>
                <span className="shrink-0 text-[12px] text-faint">{itemPriceLabel(item)}</span>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * The items whose names hold the text, case aside, and every item while the box is empty. The
 * row's own item is not offered again while the box still reads its name; the same name typed by
 * hand is, so it can still be picked.
 */
export function suggestions(items: InvoiceItem[], text: string, pickedId: string | null) {
  const typed = text.trim().toLowerCase();
  return items.filter(
    (item) =>
      !(item.id === pickedId && item.name === text) && item.name.toLowerCase().includes(typed),
  );
}

type FieldPlace = {
  left: number;
  width: number;
  top: number;
  bottom: number;
  drop: "down" | "up";
};

/**
 * Where the box is on the screen while the list is open, kept up with any scrolling ancestor and
 * the window. The list hangs below it, or above when below is too tight and above is roomier;
 * "below" ends at the phone's keyboard, which the visual viewport leaves out and the window does not.
 */
function useFieldPlace(field: RefObject<HTMLElement | null>, open: boolean) {
  const [at, setAt] = useState<FieldPlace | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setAt(null);
      return;
    }
    const place = () => {
      const r = field.current?.getBoundingClientRect();
      if (!r) return;
      const view = window.visualViewport;
      const below = (view ? view.offsetTop + view.height : window.innerHeight) - r.bottom;
      const next: FieldPlace = {
        left: r.left,
        width: r.width,
        top: r.top,
        bottom: r.bottom,
        drop: below < LIST_MAX_PX && r.top > below ? "up" : "down",
      };
      // the list's own scroll reaches this listener too, and moves nothing
      setAt((prev) =>
        prev &&
        prev.left === next.left &&
        prev.width === next.width &&
        prev.top === next.top &&
        prev.drop === next.drop
          ? prev
          : next,
      );
    };
    place();
    // a phone's keyboard moves only the visual viewport, and on iOS only after the focus
    const view = window.visualViewport;
    window.addEventListener("scroll", place, true); // capture: the rows' own scroll box too
    window.addEventListener("resize", place);
    view?.addEventListener("resize", place);
    view?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      view?.removeEventListener("resize", place);
      view?.removeEventListener("scroll", place);
    };
  }, [open, field]);

  return at;
}

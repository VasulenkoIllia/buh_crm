import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { itemPriceLabel, type InvoiceItem } from "@shared/schema/invoice-items";
import { cn } from "@/shared/lib/cn";
import { Input } from "@/shared/ui/field";

/** max-h-56, the list's own scroll beyond it */
const LIST_MAX_PX = 224;

const OPTION =
  "flex cursor-pointer items-baseline justify-between gap-3 px-3 py-1.5 text-[13px] max-sm:min-h-11 max-sm:items-center";

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
 *
 * A name typed by hand that no item has is offered last, to be added to the items (owner,
 * 2026-11-04): saved at once, so the next invoice finds it.
 */
export function PositionInput({
  value,
  items,
  pickedId,
  placeholder,
  onText,
  onPick,
  add,
}: {
  value: string;
  /** the items the picker may offer: active ones only */
  items: InvoiceItem[];
  /** the item the row came from, not offered again while the row still reads its name */
  pickedId: string | null;
  placeholder: string;
  onText: (text: string) => void;
  onPick: (item: InvoiceItem) => void;
  /**
   * Adding the typed name to the items: what the new item would be, shown beside the offer, and the
   * request, which settles once the row has it. Absent where the caller may not add.
   */
  add?: { as: Pick<InvoiceItem, "unit" | "price">; run: (name: string) => Promise<unknown> };
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  // both kept with the name they are about: rows are keyed by index, so a row removed above
  // hands this box another row, and the text may change while the request runs
  const [addingName, setAddingName] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ name: string; message: string } | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const at = useFieldPlace(field, open);
  const listId = useId();
  const matches = open ? suggestions(items, value, pickedId) : [];
  const name = value.trim();
  const adding = addingName === name;
  // shown until the text changes, so a box left meanwhile shows it again
  const addError = failed?.name === name ? failed.message : null;
  const offersAdd = open && !!add && offersNewItem(items, value, pickedId);
  // the offer is the last option, after the matches
  const count = matches.length + (offersAdd ? 1 : 0);
  const shown = at !== null && count > 0;
  const active = Math.min(highlight, count - 1);
  const optionId = (i: number) => `${listId}-${i}`;

  const show = () => {
    setOpen(true);
    setHighlight(-1);
  };
  const pick = (item: InvoiceItem) => {
    onPick(item);
    setOpen(false);
  };
  const addTyped = () => {
    if (!add || adding) return;
    const adds = name;
    setAddingName(adds);
    setFailed(null);
    add
      .run(adds)
      .then(
        // the list closes only under the text it added: typing on keeps it open
        () => {
          if (field.current?.value.trim() === adds) setOpen(false);
        },
        (e: unknown) =>
          setFailed({
            name: adds,
            message: e instanceof Error ? e.message : "Could not add the item",
          }),
      )
      .finally(() => setAddingName((now) => (now === adds ? null : now)));
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
            const next = Math.max(0, Math.min(count - 1, active + step));
            setHighlight(next);
            // the arrows, not the mouse, keep the highlighted row in sight past the list's edge
            document.getElementById(optionId(next))?.scrollIntoView({ block: "nearest" });
          } else if (e.key === "Enter" && active >= 0) {
            e.preventDefault();
            if (active < matches.length) pick(matches[active]);
            else addTyped();
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
            <div id={listId} role="listbox" aria-label="Invoice items">
              {matches.map((item, i) => (
                <div
                  key={item.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  // a click, which a screen reader's double tap also sends
                  onClick={() => pick(item)}
                  onMouseEnter={() => setHighlight(i)}
                  className={cn(OPTION, i === active && "bg-divider")}
                >
                  <span className="min-w-0 break-words">{item.name}</span>
                  <span className="shrink-0 text-[12px] text-faint">
                    {itemPriceLabel(item)}
                  </span>
                </div>
              ))}
              {offersAdd && (
                <div
                  id={optionId(matches.length)}
                  role="option"
                  aria-selected={active === matches.length}
                  aria-disabled={adding}
                  onClick={addTyped}
                  onMouseEnter={() => setHighlight(matches.length)}
                  className={cn(
                    OPTION,
                    matches.length > 0 && "border-t border-divider",
                    active === matches.length && "bg-divider",
                  )}
                >
                  <span className="min-w-0 break-words text-primary-link">
                    {adding ? "Adding…" : `+ Add “${name}” to items`}
                  </span>
                  <span className="shrink-0 text-[12px] text-faint">
                    {itemPriceLabel(add.as)}
                  </span>
                </div>
              )}
            </div>
            {/* held at the list's foot, or a long list would scroll it out of sight */}
            {addError && (
              <p
                role="alert"
                className="sticky bottom-0 border-t border-divider bg-surface px-3 py-1.5 text-[12px] text-danger-text"
              >
                {addError}
              </p>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * The items whose names hold the text, case aside, and every item while the box is empty, by name:
 * the list scrolls in its own 224px, and typing narrows it. Every one, not the first few (owner,
 * 2026-11-03, the day a cap of six went out): somebody who does not remember an item's name has to
 * be able to find it by looking. The row's own item is not offered again while the box still reads
 * its name; the same name typed by hand is, so it can still be picked.
 */
export function suggestions(items: InvoiceItem[], text: string, pickedId: string | null) {
  const typed = text.trim().toLowerCase();
  return items.filter(
    (item) =>
      !(item.id === pickedId && item.name === text) && item.name.toLowerCase().includes(typed),
  );
}

/**
 * Whether the typed text is offered as a new item: a position typed by hand, not one picked from an
 * item ("W-2 form, 2025" is still the W-2), whose name no active item has, case aside. A name a
 * switched-off item has is offered, and the server says it is switched off.
 */
export function offersNewItem(items: InvoiceItem[], text: string, pickedId: string | null) {
  const typed = text.trim().toLowerCase();
  return (
    pickedId === null &&
    typed !== "" &&
    !items.some((item) => item.name.toLowerCase() === typed)
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

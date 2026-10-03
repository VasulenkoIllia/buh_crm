import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
} from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { IconConfirm } from "./icons";
import { cn } from "@/shared/lib/cn";
import { IconButton } from "./button";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** why it is disabled — a disabled action still says why not (design-system.md) */
  hint?: string;
  /**
   * The one already chosen, for a menu that picks rather than acts — who a task is assigned to.
   * A tick in a reserved column, so the labels line up whether or not anything is ticked, and
   * `aria-checked` with `menuitemradio` so it is a CHOICE to a screen reader and not a command.
   */
  checked?: boolean;
}

/**
 * **A row's "⋯" menu.** One list of what can be done to the row, instead of a strip of icons that
 * would crowd a narrow column. Rendered in a portal at a fixed position, so a table's overflow
 * cannot clip it, and flipped upwards near the bottom of the screen. A click elsewhere or a scroll
 * closes it.
 *
 * It is a menu to the keyboard too: opening it puts the focus on its first action, the arrow keys,
 * Home and End move between actions, and Escape or Tab close it and hand the focus back to the
 * button that opened it.
 *
 * Pointer events stop at the trigger: a row that can be dragged must not start a drag, and a row
 * that can be selected must not be selected, by opening its menu.
 */
/** What a caller's own button needs to open the menu, and to have the focus handed back to it. */
export interface MenuButtonProps {
  ref: RefObject<HTMLButtonElement | null>;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
}

export function Menu({
  label,
  items,
  trigger,
  button: renderButton,
}: {
  label: string;
  items: (MenuItem | "divider")[];
  trigger?: ReactNode;
  /** a button of the caller's own in place of the "⋯", such as the Files screen's Upload */
  button?: (props: MenuButtonProps) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // both roles: an item that PICKS is a `menuitemradio`, and leaving it out of this would have
  // left the whole menu without arrow keys or an opening focus the moment one appeared
  const actions = () =>
    Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled),[role="menuitemradio"]:not(:disabled)',
      ) ?? [],
    );
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!list.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    const scroll = () => setOpen(false);
    window.addEventListener("mousedown", outside);
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !button.current || !list.current) return;
    const r = button.current.getBoundingClientRect();
    const w = list.current.offsetWidth;
    const h = list.current.offsetHeight;
    setAt({
      left: Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)),
      top: r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4,
    });
  }, [open]);

  /**
   * Once it stands where it belongs, the focus goes in — to the one already CHOSEN when the menu
   * picks, and to the first action otherwise.
   *
   * A menu that picks opens with "Unassigned" at the top, so landing on the first item and
   * pressing Enter, which is what a keyboard does, took the person off the job. The chosen one is
   * the only safe place to start: Enter on it changes nothing.
   */
  useEffect(() => {
    if (!open || !at) return;
    const all = actions();
    const chosen = all.find((a) => a.getAttribute("aria-checked") === "true");
    (chosen ?? all[0])?.focus({ preventScroll: true });
  }, [open, at]);

  const buttonProps: MenuButtonProps = {
    ref: button,
    "aria-haspopup": "menu",
    "aria-expanded": open,
    onPointerDown: (e) => e.stopPropagation(),
    onClick: (e) => {
      e.stopPropagation();
      setAt(null);
      setOpen((o) => !o);
    },
  };

  /** a menu that picks keeps the tick's column on every row, so the labels do not shift */
  const picks = items.some((i) => i !== "divider" && i.checked !== undefined);

  return (
    <>
      {renderButton ? (
        renderButton(buttonProps)
      ) : (
        <IconButton {...buttonProps} label={label}>
          {trigger ?? <MoreHorizontal size={16} />}
        </IconButton>
      )}
      {open &&
        createPortal(
          <div
            ref={list}
            role="menu"
            aria-label={label}
            style={{ top: at?.top ?? -9999, left: at?.left ?? -9999 }}
            className="fixed z-40 min-w-[200px] rounded-(--radius-card) border border-border bg-surface p-1 shadow-(--shadow-modal)"
            onPointerDown={(e) => e.stopPropagation()}
            /*
              The CLICK as well as the pointer, and on the LIST rather than only on its items.

              A portal moves the DOM and not the React tree, so every event here still bubbles to
              whatever rendered the menu. The items stopped their own clicks; the `p-1` padding,
              the divider and the border did not — so a click 3px off a name reached the board
              card's `onClick` and opened the task, with the menu left standing behind the modal.
              Found the first time a `Menu` was put inside something clickable (audit, 2026-10-03).
            */
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              const all = actions();
              const i = all.indexOf(document.activeElement as HTMLButtonElement);
              const go = (n: number) => {
                e.preventDefault();
                all[(n + all.length) % all.length]?.focus();
              };
              if (e.key === "ArrowDown") go(i + 1);
              else if (e.key === "ArrowUp") go(i < 0 ? -1 : i - 1);
              else if (e.key === "Home") go(0);
              else if (e.key === "End") go(-1);
              else if (e.key === "Escape" || e.key === "Tab") {
                // the menu's own key: a row list behind it must not take it as well
                e.preventDefault();
                e.stopPropagation();
                close(true);
              }
            }}
          >
            {items.map((item, i) =>
              item === "divider" ? (
                <hr key={`divider-${i}`} className="mx-0.5 my-1 border-divider" />
              ) : (
                <button
                  // not the label: two teammates can be called the same thing
                  key={`${i}-${item.label}`}
                  type="button"
                  role={item.checked === undefined ? "menuitem" : "menuitemradio"}
                  aria-checked={item.checked}
                  disabled={item.disabled}
                  title={item.hint}
                  onClick={(e) => {
                    e.stopPropagation();
                    // back to the trigger first, so an action that takes the focus (a name field)
                    // keeps it
                    close(true);
                    item.onSelect();
                  }}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-(--radius-btn-sm) px-2.5 py-1.5 text-left text-[13px] text-ink-700 outline-none",
                    "hover:bg-divider hover:text-ink focus-visible:bg-divider focus-visible:text-ink",
                    "disabled:cursor-not-allowed disabled:text-faint disabled:hover:bg-transparent",
                    item.danger &&
                      "text-danger-text hover:bg-danger-soft hover:text-danger-text focus-visible:bg-danger-soft focus-visible:text-danger-text",
                  )}
                >
                  {picks && (
                    <IconConfirm
                      size={14}
                      className={cn("flex-none", item.checked ? "text-primary" : "invisible")}
                    />
                  )}
                  {item.icon}
                  {item.label}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

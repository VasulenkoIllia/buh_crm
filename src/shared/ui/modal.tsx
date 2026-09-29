import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/shared/lib/cn";

const SIZES = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
  /** a form laid out in three columns so it is one screen tall (the meeting) */
  "2xl": "max-w-6xl",
} as const;

export function Modal({
  title,
  open,
  onClose,
  children,
  footer,
  actions,
  size = "sm",
  fit = false,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * Icons in the top right, before the ×: **Copy link** lives here on every record, and anything
   * else of that weight belongs beside it (owner, 2026-09-20: "в тому ж місці в правому верхньому
   * кутку… що б був один вигляд"). Words belong in `footer`.
   */
  actions?: ReactNode;
  size?: keyof typeof SIZES;
  /**
   * **Lists give way before the form scrolls.** The body becomes a flex column, so a descendant
   * chain of `flex min-h-0 flex-col` ending in a list marked `min-h-0 overflow-y-auto` shrinks to
   * whatever the window leaves, and scrolls in place, while the fields around it stay put. Nothing
   * else changes: an element that does not opt in keeps its height, and a form that is simply too
   * tall still scrolls as before. Opt-in, because in a flex column an inline control that is a
   * direct child would stretch to the full width (owner, 2026-09-29: no scroll in the modals on a
   * 13-inch MacBook, where a user-grown list is the one thing that cannot be sized in advance).
   */
  fit?: boolean;
}) {
  // Was the mousedown on the backdrop itself? Only then does a full click close it —
  // so a text-selection drag that ends on the backdrop doesn't dismiss the modal.
  const downOnBackdrop = useRef(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    // stopPropagation so no pointer event inside the modal bubbles (via the React tree)
    // to whatever rendered it — e.g. a board card whose onClick would fire, or its
    // dnd-kit drag listener (onPointerDown) which would otherwise start dragging the
    // card behind the modal when you select text or click inside it.
    // Close on a full backdrop click (down+up on the backdrop), never on mousedown alone:
    // closing on mousedown unmounts before mouseup, and the trailing click hits the card below.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => {
        e.stopPropagation();
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
        downOnBackdrop.current = false;
      }}
    >
      {/*
        As tall as the window allows, less the backdrop's own `p-4`. It was `max-h-[88vh]`, which on
        a 13-inch MacBook (a 680px window) left a form 484px and the meeting form scrolled by 215
        (owner, 2026-09-29). `dvh`, not `vh`: on a phone `vh` counts the space under the browser's
        own bars, and the footer would sit behind them.
      */}
      <div
        className={cn(
          "flex max-h-[calc(100dvh-2rem)] w-full flex-col rounded-(--radius-panel) bg-surface shadow-(--shadow-modal)",
          SIZES[size],
        )}
      >
        <div className="flex flex-none items-center gap-2 border-b border-divider px-5 py-3">
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{title}</h2>
          {actions}
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted hover:bg-divider"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4", fit && "flex flex-col")}>
          {children}
        </div>
        {footer && (
          <div className="flex flex-none justify-end gap-2 border-t border-divider px-5 py-2.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

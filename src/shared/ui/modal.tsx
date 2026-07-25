import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/shared/lib/cn";

const SIZES = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
} as const;

export function Modal({
  title,
  open,
  onClose,
  children,
  footer,
  size = "sm",
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof SIZES;
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
      <div
        className={cn(
          "flex max-h-[88vh] w-full flex-col rounded-(--radius-panel) bg-surface shadow-(--shadow-modal)",
          SIZES[size],
        )}
      >
        <div className="flex flex-none items-center justify-between border-b border-divider px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted hover:bg-divider"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex flex-none justify-end gap-2 border-t border-divider px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

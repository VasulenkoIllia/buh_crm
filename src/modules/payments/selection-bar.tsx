import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { Archive, ArchiveRestore, CircleCheck, Mail, X } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { Button, IconButton } from "@/shared/ui/button";

/**
 * One bulk button. It always shows how many of the selection it can touch ("2 of 5") and goes
 * disabled with the reason when that's zero — so a click never looks like it did nothing.
 */
function BulkAction({
  icon,
  label,
  eligible,
  total,
  disabled,
  reason,
  tone,
  onRun,
}: {
  icon: ReactNode;
  label: string;
  eligible: number;
  total: number;
  disabled: boolean;
  reason: string;
  tone?: "positive";
  onRun: () => void;
}) {
  const none = eligible === 0;
  return (
    <Button
      size="sm"
      variant={tone === "positive" && !none ? "positive" : "secondary"}
      className="shrink-0 max-sm:h-11"
      disabled={disabled || none}
      title={none ? `Not available: ${reason}` : undefined}
      onClick={onRun}
    >
      {icon}
      {label}
      <span className="tabular-nums opacity-70">
        {none || eligible === total ? eligible : `${eligible} of ${total}`}
      </span>
    </Button>
  );
}

/**
 * Ticks the page or clears it: the headings' box, and the selection bar's at the same place, half
 * ticked while only some of the page is chosen. A press then clears, as it does when all are. One
 * name in every state: the state itself is what a reader hears change.
 */
export function PageCheckbox({
  boxRef,
  chosen,
  total,
  onAll,
  className,
}: {
  boxRef: RefObject<HTMLInputElement | null>;
  chosen: number;
  total: number;
  onAll: (on: boolean) => void;
  className?: string;
}) {
  return (
    <input
      type="checkbox"
      aria-label="Select all on this page"
      className={cn("shrink-0", className)}
      checked={total > 0 && chosen === total}
      ref={(box) => {
        boxRef.current = box;
        if (box) box.indeterminate = chosen > 0 && chosen < total;
      }}
      onChange={() => onAll(chosen === 0)}
    />
  );
}

export type BulkKind = "send" | "pay" | "tidy" | "restore";

/**
 * **The selection's bar** (owner, 2026-11-04: moved up from under the list, where it began in July,
 * and redrawn). Where it fits a line it takes the headings' place at their 44px, so no row moves
 * under the pointer. On a phone it stands at the foot of the screen, beside the sidebar, with every
 * action in reach of a thumb; it reports its height for the room the page leaves under the list.
 * Each action says how many of the selection it can touch, and is off when that is none.
 */
export function SelectionBar({
  count,
  total,
  eligible,
  settledView,
  busy,
  boxRef,
  onAll,
  onClear,
  onHeight,
  run,
}: {
  count: number;
  total: number;
  eligible: { toSend: number; toPay: number; toTidy: number };
  settledView: boolean;
  busy: boolean;
  boxRef: RefObject<HTMLInputElement | null>;
  onAll: (on: boolean) => void;
  onClear: () => void;
  onHeight: (px: number) => void;
  run: Record<BulkKind, () => void>;
}) {
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const watch = new ResizeObserver(() => onHeight(el.offsetHeight));
    watch.observe(el);
    return () => watch.disconnect();
  }, [onHeight]);

  return (
    <div
      ref={bar}
      role="group"
      aria-label="Selected invoices"
      className={cn(
        "flex min-h-11 flex-wrap items-center gap-2 border-b border-border bg-primary-soft px-4 py-1.5",
        "max-sm:fixed max-sm:right-0 max-sm:bottom-0 max-sm:left-14 max-sm:z-30 max-sm:border-t max-sm:border-b-0 max-sm:px-3 max-sm:py-2 max-sm:shadow-(--shadow-modal)",
      )}
    >
      {/* the X clears on a phone, where the headings keep their own box */}
      <PageCheckbox
        boxRef={boxRef}
        chosen={count}
        total={total}
        onAll={onAll}
        className="max-sm:hidden"
      />
      <span
        aria-live="polite"
        className="ml-1 whitespace-nowrap text-[13px] font-semibold tabular-nums text-primary-link max-sm:ml-0"
      >
        {count} selected
      </span>
      <IconButton label="Clear the selection" className="max-sm:size-11" onClick={onClear}>
        <X size={15} />
      </IconButton>
      <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border max-sm:hidden" />
      <BulkAction
        icon={<Mail />}
        label="Mark as sent"
        eligible={eligible.toSend}
        total={count}
        disabled={busy}
        reason="already marked as sent"
        onRun={run.send}
      />
      <BulkAction
        icon={<CircleCheck />}
        label="Mark as paid"
        tone="positive"
        eligible={eligible.toPay}
        total={count}
        disabled={busy}
        reason="nothing left to pay on them"
        onRun={run.pay}
      />
      {settledView ? (
        <BulkAction
          icon={<ArchiveRestore />}
          label="Restore"
          eligible={count}
          total={count}
          disabled={busy}
          reason=""
          onRun={run.restore}
        />
      ) : (
        <BulkAction
          icon={<Archive />}
          label="Tidy away"
          eligible={eligible.toTidy}
          total={count}
          disabled={busy}
          reason="only paid or cancelled invoices can be tidied away"
          onRun={run.tidy}
        />
      )}
    </div>
  );
}

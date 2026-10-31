import { useEffect, useRef, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import type { Invoice } from "@shared/schema/payment";
import { lineAmount } from "@shared/schema/payment";
import { cn } from "@/shared/lib/cn";
import { fmtMoney, moneyInputValue, parseMoney } from "@/shared/lib/money";
import { Button, IconButton } from "@/shared/ui/button";
import { Input } from "@/shared/ui/field";

/**
 * The header's and every row's columns. On a phone the five do not fit, so the name takes a line of
 * its own and the header goes, and each cell carries its name instead.
 */
const ROW =
  "grid grid-cols-[1fr_1fr_1fr_44px] items-end gap-2 sm:grid-cols-[minmax(140px,1fr)_90px_120px_120px_32px]";

/** A box and what it is: a caption on a phone, read out by a screen reader at any width. */
function Cell({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn("block min-w-0", className)}>
      <span className="mb-1 block text-[11px] text-faint sm:sr-only">{label}</span>
      {children}
    </label>
  );
}

/**
 * The positions editor — the toggle the firm asked for.
 *
 * It changes what you FILL IN, not what is stored: with it off an invoice is a single amount, as
 * every invoice was before this existed; with it on the amount is the sum of the rows. There is no
 * "invoice type" anywhere in the database, because the difference is "does it have a breakdown"
 * and the rows themselves already answer that.
 *
 * Hours are entered as hours ("3.5") and carried as hundredths, so the arithmetic stays integer —
 * a float hour times a rate is where the last cent goes missing.
 */
export function LinesEditor({
  lines,
  onChange,
}: {
  lines: DraftLine[];
  onChange: (next: DraftLine[]) => void;
}) {
  const set = (i: number, patch: Partial<DraftLine>) =>
    onChange(lines.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  /**
   * A position just added is at the foot of a list that may be scrolled or clipped: the list
   * follows it there and the cursor goes into its name. Without this the fifth "+ Position" showed
   * a sliver and nothing else, and somebody clicking again left blank rows on an invoice
   * (audit, 2026-09-29).
   */
  const list = useRef<HTMLDivElement>(null);
  const count = useRef(lines.length);
  useEffect(() => {
    if (lines.length > count.current) {
      const row = list.current?.lastElementChild;
      row?.scrollIntoView({ block: "nearest" });
      row?.querySelector("input")?.focus({ preventScroll: true });
    }
    count.current = lines.length;
  }, [lines.length]);

  return (
    // a flex column so the rows can give way inside a `fit` modal (see shared/ui/modal.tsx)
    <div className="flex min-h-0 flex-col gap-1.5">
      <div
        className={cn(
          ROW,
          "text-[11px] font-medium uppercase tracking-wide text-faint max-sm:hidden",
        )}
      >
        <div>Position</div>
        <div className="text-right">Hours</div>
        <div className="text-right">Rate</div>
        <div className="text-right">Amount</div>
        <div />
      </div>

      {/* up to four rows show; a longer list scrolls in place rather than pushing the form off
          the screen, and inside a `fit` modal it gives way further, down to one row */}
      {/* `-mx-1 px-1 py-0.5`: room for a focused field's ring inside the scroll edge */}
      <div
        ref={list}
        className="-mx-1 max-h-[176px] min-h-[46px] space-y-1.5 overflow-y-auto px-1 py-0.5"
      >
        {lines.map((line, i) => {
          const computed = draftAmount(line);
          return (
            <div key={i} className={ROW}>
              <Cell label="Position" className="max-sm:col-span-full">
                <Input
                  value={line.description}
                  placeholder="Consultation"
                  onChange={(e) => set(i, { description: e.target.value })}
                />
              </Cell>
              <Cell label="Hours">
                <Input
                  inputMode="decimal"
                  className="text-right"
                  value={line.hours}
                  onChange={(e) => set(i, { hours: e.target.value })}
                />
              </Cell>
              <Cell label="Rate">
                <Input
                  inputMode="decimal"
                  className="text-right"
                  value={line.rate}
                  onChange={(e) => set(i, { rate: e.target.value })}
                />
              </Cell>
              {/* read-only the moment hours AND a rate are both there — the number is theirs, and
                two editable fields that must agree is how they stop agreeing */}
              <Cell label="Amount">
                <Input
                  inputMode="decimal"
                  className="text-right"
                  value={computed !== null ? moneyInputValue(computed) : line.amount}
                  readOnly={computed !== null}
                  onChange={(e) => set(i, { amount: e.target.value })}
                />
              </Cell>
              <IconButton
                label="Remove this position"
                className="hover:text-danger max-sm:size-11"
                onClick={() => onChange(lines.filter((_, n) => n !== i))}
              >
                <Trash2 size={15} />
              </IconButton>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between pt-1">
        <Button
          size="sm"
          variant="secondary"
          className="max-sm:h-11"
          onClick={() => onChange([...lines, emptyLine()])}
        >
          + Position
        </Button>
        <span className="text-[13px]">
          Total{" "}
          <span className="font-semibold tabular-nums">{fmtMoney(draftTotal(lines))}</span>
        </span>
      </div>
    </div>
  );
}

/** A row while it is being typed — strings, because a half-typed number is not a number yet. */
export interface DraftLine {
  description: string;
  hours: string;
  rate: string;
  amount: string;
}

export const emptyLine = (): DraftLine => ({
  description: "",
  hours: "",
  rate: "",
  amount: "",
});

/** Hours as typed → hundredths of an hour. "3.5" → 350. */
const parseHours = (text: string): number | null => {
  const n = Number(text.replace(",", ".").trim());
  return text.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : Math.round(n * 100);
};

/** A row's amount when hours AND a rate are both present — otherwise the typed one stands. */
function draftAmount(line: DraftLine): number | null {
  const hours = parseHours(line.hours);
  const rate = parseMoney(line.rate);
  return hours !== null && rate > 0 ? lineAmount(hours, rate) : null;
}

export const draftTotal = (lines: DraftLine[]) =>
  lines.reduce((sum, l) => sum + (draftAmount(l) ?? parseMoney(l.amount)), 0);

/** Draft rows → what the API takes. */
export const toLineInput = (lines: DraftLine[]) =>
  lines.map((l) => {
    const hours = parseHours(l.hours);
    const rate = parseMoney(l.rate);
    return {
      description: l.description.trim(),
      quantity: hours,
      unitRate: rate > 0 ? rate : null,
      amount: draftAmount(l) ?? parseMoney(l.amount),
    };
  });

/** A stored invoice's positions → editable rows. */
export const toDraftLines = (lines: Invoice["lines"]): DraftLine[] =>
  lines.map((l) => ({
    description: l.description,
    hours: l.quantity != null ? String(l.quantity / 100) : "",
    rate: l.unitRate != null ? moneyInputValue(l.unitRate) : "",
    amount: moneyInputValue(l.amount),
  }));

import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import type { InvoiceLineUnit } from "@shared/schema/enums";
import type { CreateInvoiceItemInput, InvoiceItem } from "@shared/schema/invoice-items";
import type { Invoice } from "@shared/schema/payment";
import { FRACTIONAL_ITEMS, isFractionalItemCount, lineAmount } from "@shared/schema/payment";
import { useCanEdit } from "@/app/auth";
import { cn } from "@/shared/lib/cn";
import { fmtMoney, moneyInputValue, parseMoney } from "@/shared/lib/money";
import { Button, IconButton } from "@/shared/ui/button";
import { Input } from "@/shared/ui/field";
import { useInvoiceItems } from "@/modules/settings";
import { NewItemModal } from "./new-item-modal";
import { PositionInput } from "./position-input";

/**
 * The header's and every row's columns. On a phone the five do not fit, so the name takes a line of
 * its own with the bin beside it, the header goes, and each cell carries its name instead. Below it
 * Qty is the widest, because its unit switch takes 44px of it, and Rate keeps room for "200.00";
 * Amount takes the bin's column too.
 */
const ROW =
  "grid grid-cols-[1.3fr_1.15fr_1fr_44px] items-end gap-2 sm:grid-cols-[minmax(140px,1fr)_100px_120px_120px_32px]";

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
 * A quantity is entered as hours ("3.5") or items ("2"), the row's own choice, and carried as
 * hundredths, so the arithmetic stays integer — a float hour times a rate is where the last cent
 * goes missing.
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
  // offered under every row's Position box; a failed load leaves the box a plain one. All of them,
  // inactive too, still name the item an old line came from.
  const allItems = useInvoiceItems().data;
  const items = pickableItems(allItems);

  // a name the list lacks is added from its row, by whoever bills (owner, 2026-11-04), in the item's
  // own form (2026-11-05). The row is linked once the item is back, as the rows are then
  const canAdd = useCanEdit("billing");
  const [newItem, setNewItem] = useState<{
    row: number;
    initial: CreateInvoiceItemInput;
  } | null>(null);
  const latest = useRef(lines);
  useEffect(() => {
    latest.current = lines;
  });
  const linkAdded = (i: number, item: InvoiceItem) => {
    const patch = addedPosition(latest.current[i], item);
    if (patch) onChange(latest.current.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  };

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
        <div className="text-right">Qty</div>
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
          // the box left empty beside an amount shows its share as it is typed, and keeps it once
          // the cursor leaves a number: the amount is then quantity × rate, read-only like any
          const shown = completedLine(line);
          const keepShown = (e: FocusEvent<HTMLInputElement>) => {
            // the window losing focus (another app, a phone's browser put away) blurs the box
            // too, and leaves it focused: the cursor did not leave, so nothing is settled
            if (document.activeElement === e.currentTarget) return;
            const settled = settledLine(line);
            const { quantity, rate, amount } = settled;
            if (settled !== line) set(i, { quantity, rate, amount });
          };
          return (
            <div key={i} className={ROW}>
              <Cell label="Position" className="max-sm:col-span-3">
                <PositionInput
                  value={line.description}
                  items={items}
                  pickedId={line.itemId}
                  placeholder={items.length > 0 ? "Pick an item or type" : "Consultation"}
                  onText={(text) => set(i, typedPosition(line, text, allItems))}
                  onPick={(item) => set(i, pickedPosition(line, item))}
                  add={
                    // not before the items load: every name would look new
                    canAdd && allItems
                      ? (name) =>
                          setNewItem({ row: i, initial: { name, ...itemFromRow(line) } })
                      : undefined
                  }
                />
              </Cell>
              <Cell label="Qty">
                <div className="relative">
                  {/* named on its own: the cell's label also holds the unit switch, whose name
                      would otherwise be read out as part of this box's */}
                  <Input
                    aria-label="Qty"
                    inputMode="decimal"
                    className="pr-10 text-right max-sm:pr-[46px]"
                    value={shown.quantity}
                    onChange={(e) => set(i, { quantity: e.target.value })}
                    onBlur={keepShown}
                  />
                  {/* a rate is per unit, so a new unit empties it: the client's last hourly rate,
                      offered on the first row, is no price per item */}
                  <UnitToggle
                    unit={line.unit}
                    onChange={(unit) => set(i, { unit, rate: "" })}
                  />
                </div>
              </Cell>
              <Cell label="Rate">
                <Input
                  inputMode="decimal"
                  className="text-right"
                  value={shown.rate}
                  onChange={(e) => set(i, { rate: e.target.value })}
                  onBlur={keepShown}
                />
              </Cell>
              {/* read-only the moment a quantity AND a rate are both there — the number is theirs, and
                two editable fields that must agree is how they stop agreeing */}
              <Cell label="Amount" className="max-sm:col-span-2">
                <Input
                  inputMode="decimal"
                  className="text-right"
                  value={computed !== null ? moneyInputValue(computed) : line.amount}
                  readOnly={computed !== null}
                  onChange={(e) => set(i, { amount: e.target.value })}
                  onBlur={keepShown}
                />
              </Cell>
              <IconButton
                label="Remove this position"
                className="hover:text-danger max-sm:col-start-4 max-sm:row-start-1 max-sm:size-11"
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

      {newItem && (
        <NewItemModal
          initial={newItem.initial}
          onAdded={(item) => linkAdded(newItem.row, item)}
          onClose={() => setNewItem(null)}
        />
      )}
    </div>
  );
}

const UNIT_MARK: Record<InvoiceLineUnit, string> = { hour: "h", item: "pcs" };

/**
 * What the row counts, inside its Qty box: one press switches hours and items (client, 2026-11-02:
 * "2 items at $50"). A box of its own would not fit the row on a phone.
 */
function UnitToggle({
  unit,
  onChange,
}: {
  unit: InvoiceLineUnit;
  onChange: (unit: InvoiceLineUnit) => void;
}) {
  return (
    <IconButton
      // the mark it shows comes first, so a voice command saying "pcs" finds it
      label={`Unit: ${UNIT_MARK[unit]}. Switch to ${unit === "hour" ? "items" : "hours"}`}
      onClick={() => onChange(unit === "hour" ? "item" : "hour")}
      className="absolute inset-y-px right-px h-auto w-9 rounded-none rounded-r-(--radius-field) border-l border-divider text-[12px] font-medium max-sm:inset-y-0 max-sm:w-11"
    >
      {UNIT_MARK[unit]}
    </IconButton>
  );
}

/** A row while it is being typed — strings, because a half-typed number is not a number yet. */
export interface DraftLine {
  description: string;
  /** hours or items, as the row's unit says */
  quantity: string;
  rate: string;
  amount: string;
  unit: InvoiceLineUnit;
  /** the invoice item it was picked from; null = typed by hand */
  itemId: string | null;
  /**
   * The numbers the row was offered with, when nobody typed them: a line of an issued invoice, or
   * the first row a service's price and the client's last rate suggest. While the row still holds
   * them nothing is filled in, so a correction saved for its due date moves no line by a cent, and a
   * price beside a last rate invents no hours. Typing a digit and deleting it changes nothing.
   */
  untouched?: Pick<DraftLine, "quantity" | "rate" | "amount">;
}

/** A row as offered rather than typed (`untouched`). */
export const offeredLine = (line: DraftLine): DraftLine => ({
  ...line,
  untouched: { quantity: line.quantity, rate: line.rate, amount: line.amount },
});

const asOffered = ({ untouched: was, quantity, rate, amount }: DraftLine) =>
  was !== undefined && was.quantity === quantity && was.rate === rate && was.amount === amount;

export const emptyLine = (): DraftLine => ({
  description: "",
  quantity: "",
  rate: "",
  amount: "",
  unit: "hour",
  itemId: null,
});

/** What the picker offers: an inactive item stays on the lines it is on and leaves the list. */
export const pickableItems = (items: InvoiceItem[] | undefined) =>
  items?.filter((item) => item.active) ?? [];

/**
 * A row with an invoice item picked (payments.md §3): its name, unit and price, and a count of 1
 * unless one is typed. An item with no set price keeps a rate typed for it or for the row before
 * any pick (the client's last one included), for the same unit: a rate is per unit, and another
 * item's price is no rate of this one. Everything stays editable, and what the row then shows is what is stored.
 */
export const pickedPosition = (line: DraftLine, item: InvoiceItem): Partial<DraftLine> => ({
  description: item.name,
  unit: item.unit,
  quantity: line.quantity.trim() || "1",
  rate:
    item.price !== null
      ? moneyInputValue(item.price)
      : (line.itemId === null || line.itemId === item.id) && item.unit === line.unit
        ? line.rate
        : "",
  amount: "",
  itemId: item.id,
});

/**
 * A row with its name typed: a position by hand. One picked from an item keeps the link while the
 * text still holds the item's name ("W-2 form, 2025"), and lets go once it does not: "Filing fee"
 * typed over a W-2 is no W-2. An item this browser does not know keeps it while the box is not
 * empty, since there is no name to hold the text to.
 */
export function typedPosition(
  line: DraftLine,
  text: string,
  items: InvoiceItem[] | undefined,
): Partial<DraftLine> {
  if (!line.itemId || !text.trim()) return { description: text, itemId: null };
  const name = items?.find((item) => item.id === line.itemId)?.name;
  const holdsName = name === undefined || text.toLowerCase().includes(name.toLowerCase());
  return { description: text, itemId: holdsName ? line.itemId : null };
}

/**
 * The invoice item a row typed by hand would add (owner, 2026-11-04): its unit, and the rate it
 * shows, when there is one. With none the item's price is typed on each invoice, until Settings sets it.
 */
export const itemFromRow = (line: DraftLine): Pick<InvoiceItem, "unit" | "price"> => {
  const rate = parseMoney(completedLine(line).rate);
  return { unit: line.unit, price: rate > 0 ? rate : null };
};

/**
 * A row linked to the item just added from it (2026-11-05): the name, unit and price the form saved,
 * which may differ from the row's, as a pick hands them over. An item with no price leaves the row's
 * numbers as they are, since a pick would put a count of 1 over an amount typed by hand, and a new
 * unit still empties the rate, as the unit switch does. Nothing when the row is gone or already
 * names an item: the offer is made only on a row typed by hand.
 */
export function addedPosition(
  line: DraftLine | undefined,
  item: InvoiceItem,
): Partial<DraftLine> | null {
  if (!line || line.itemId !== null) return null;
  if (item.price !== null) return pickedPosition(line, item);
  return {
    description: item.name,
    itemId: item.id,
    unit: item.unit,
    ...(item.unit !== line.unit ? { rate: "" } : {}),
  };
}

/** A quantity as typed → hundredths of a unit. "3.5" → 350. */
const parseQuantity = (text: string): number | null => {
  const n = Number(text.replace(",", ".").trim());
  return text.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : Math.round(n * 100);
};

/** A row's amount when a quantity AND a rate are both present — otherwise the typed one stands. */
function draftAmount(line: DraftLine): number | null {
  const quantity = parseQuantity(line.quantity);
  const rate = parseMoney(line.rate);
  return quantity !== null && rate > 0 ? lineAmount(quantity, rate) : null;
}

/**
 * Two of the three give the third (owner, 2026-11-03): an amount and a rate fill an empty quantity,
 * an amount and a quantity an empty rate. The share is rounded to a hundredth of a unit or to the
 * cent, and the amount is then quantity × rate like any row's, so it may move a few cents from the
 * one typed: 3 hours and $100 are $33.33 and $99.99 (the owner's choice over leaving the box
 * empty). A count of items that does not come out whole is left to be typed. The same row comes
 * back when there is nothing to fill.
 */
export function completedLine(line: DraftLine): DraftLine {
  const amount = parseMoney(line.amount);
  const noQuantity = line.quantity.trim() === "";
  const noRate = line.rate.trim() === "";
  if (asOffered(line) || amount <= 0 || noQuantity === noRate) return line;
  if (noQuantity) {
    const rate = parseMoney(line.rate);
    const quantity = rate > 0 ? Math.round((amount * 100) / rate) : 0;
    const whole = line.unit !== "item" || quantity % 100 === 0;
    return quantity > 0 && whole ? { ...line, quantity: String(quantity / 100) } : line;
  }
  const quantity = parseQuantity(line.quantity);
  const rate = quantity !== null ? Math.round((amount * 100) / quantity) : 0;
  return rate > 0 ? { ...line, rate: moneyInputValue(rate) } : line;
}

/**
 * A row as it stays once the cursor leaves a number: the share it shows is kept, and an amount typed
 * before quantity and rate were both there goes, since the amount is theirs now. Kept, it would
 * fill whichever of the two is emptied next, so that box could not be emptied and the row could not
 * go back to an amount typed by hand.
 */
export function settledLine(line: DraftLine): DraftLine {
  const shown = completedLine(line);
  return draftAmount(shown) !== null && shown.amount !== "" ? { ...shown, amount: "" } : shown;
}

export const draftTotal = (lines: DraftLine[]) =>
  lines
    .map(completedLine)
    .reduce((sum, l) => sum + (draftAmount(l) ?? parseMoney(l.amount)), 0);

/** What the server would refuse about the rows, said before the request rather than after it. */
export const linesProblem = (lines: DraftLine[]): string | null =>
  lines.some((l) =>
    isFractionalItemCount({ unit: l.unit, quantity: parseQuantity(l.quantity) }),
  )
    ? FRACTIONAL_ITEMS
    : null;

/**
 * Draft rows → what the API takes, each with the share it shows. A unit goes only beside a
 * quantity, which it describes.
 */
export const toLineInput = (lines: DraftLine[]) =>
  lines.map(completedLine).map((l) => {
    const quantity = parseQuantity(l.quantity);
    const rate = parseMoney(l.rate);
    return {
      description: l.description.trim(),
      quantity,
      unitRate: rate > 0 ? rate : null,
      amount: draftAmount(l) ?? parseMoney(l.amount),
      unit: quantity !== null ? l.unit : null,
      itemId: l.itemId,
    };
  });

/**
 * A stored invoice's positions → editable rows, as offered. A line from before units counted hours.
 * A line with a quantity and a rate opens with no amount of its own: its amount is theirs, as on the
 * server, and one kept would fill whichever of the two is emptied.
 */
export const toDraftLines = (lines: Invoice["lines"]): DraftLine[] =>
  lines.map((l) =>
    offeredLine({
      description: l.description,
      quantity: l.quantity != null ? String(l.quantity / 100) : "",
      rate: l.unitRate != null ? moneyInputValue(l.unitRate) : "",
      amount: l.quantity != null && l.unitRate != null ? "" : moneyInputValue(l.amount),
      unit: l.unit ?? "hour",
      itemId: l.itemId,
    }),
  );

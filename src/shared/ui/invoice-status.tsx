import { INVOICE_STATUS_COLORS } from "@/shared/lib/colors";
import { cn } from "@/shared/lib/cn";

/**
 * Settlement state of an invoice (unpaid / partial / paid / overdue / cancelled).
 * Lives in shared/ui, not in the Payments module, so a task card can show its job's
 * billing state without Tasks importing Payments (which imports Tasks back).
 *
 * `prefix` renders the 💰 marker used on task cards; `size="sm"` is the dense chip
 * variant for kanban cards and rollup rows.
 */
export function InvoiceStatusPill({
  status,
  prefix,
  size = "md",
}: {
  status: string;
  prefix?: string;
  size?: "sm" | "md";
}) {
  const c = INVOICE_STATUS_COLORS[status] ?? INVOICE_STATUS_COLORS.unpaid;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-(--radius-chip) font-medium capitalize",
        size === "sm" ? "px-[6px] py-[1px] text-[11px]" : "px-2 py-0.5 text-[12px]",
      )}
      style={{ color: c.fg, backgroundColor: c.bg }}
    >
      {prefix && <span className="mr-1 not-italic">{prefix}</span>}
      {status}
    </span>
  );
}

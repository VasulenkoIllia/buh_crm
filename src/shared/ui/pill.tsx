import { USER_STATUS_COLORS } from "@/shared/lib/colors";
import { cn } from "@/shared/lib/cn";

/** Shared styling for chip-style choice buttons (selectable filter/option pills). */
export const pillCls = (selected: boolean) =>
  cn(
    "rounded-(--radius-chip) border px-2.5 py-1 text-[12px] font-medium",
    selected
      ? "border-primary bg-[#eef1fb] text-primary-link"
      : "border-border bg-surface text-muted hover:bg-divider",
  );

export function StatusPill({ status }: { status: string }) {
  const colors = USER_STATUS_COLORS[status] ?? { fg: "#6b7280", bg: "#eef0f3" };
  return (
    <span
      className="inline-flex items-center rounded-(--radius-chip) px-2 py-0.5 text-[12px] font-medium capitalize"
      style={{ color: colors.fg, backgroundColor: colors.bg }}
    >
      {status}
    </span>
  );
}

import { USER_STATUS_COLORS } from "@/shared/lib/colors";

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

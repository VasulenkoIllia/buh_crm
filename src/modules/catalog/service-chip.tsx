import { categoryChip } from "@/shared/lib/colors";

/** Colored category chip — the shared representation of a service everywhere. */
export function ServiceChip({ name, color }: { name: string; color: string }) {
  const { fg, bg } = categoryChip(color);
  return (
    <span
      className="inline-flex items-center rounded-(--radius-chip) px-2 py-0.5 text-[12px] font-medium"
      style={{ color: fg, backgroundColor: bg }}
    >
      {name}
    </span>
  );
}

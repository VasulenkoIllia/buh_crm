import { cn } from "@/shared/lib/cn";

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="flex gap-1.5 rounded-(--radius-field) bg-[#eef0f3] p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            // active = the same primary blue every other tab uses (see shared/ui/tabs.tsx)
            "flex-1 rounded-(--radius-btn-sm) px-3 py-1.5 text-[13px] font-medium transition-colors",
            value === opt.value
              ? "bg-primary text-white shadow-(--shadow-card)"
              : "text-muted hover:text-ink",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

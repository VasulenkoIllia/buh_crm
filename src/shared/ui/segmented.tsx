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
            "flex-1 rounded-(--radius-btn-sm) py-1.5 text-[13px] font-medium",
            value === opt.value ? "bg-surface text-ink shadow-(--shadow-card)" : "text-muted",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

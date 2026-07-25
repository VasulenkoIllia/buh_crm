import { useState } from "react";
import { cn } from "@/shared/lib/cn";

/**
 * Edits an ordered list of checklist step texts (string[]). Type + Enter (or blur) to
 * add a step; edit inline; × removes. Empty steps are the caller's to trim before saving.
 */
export function ChecklistEditor({
  value,
  onChange,
  placeholder = "Add a step…",
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const rowCls =
    "min-w-0 flex-1 rounded-(--radius-field) border border-border px-2 py-1 text-[13px] outline-none focus:border-primary disabled:opacity-60";

  const add = () => {
    const t = text.trim();
    if (!t) return;
    onChange([...value, t]);
    setText("");
  };

  return (
    <div className="space-y-1">
      {value.map((step, i) => (
        <div key={i} className="flex items-center gap-2 text-[13px]">
          <span className="text-faint">☐</span>
          <input
            className={rowCls}
            value={step}
            disabled={disabled}
            onChange={(e) => onChange(value.map((s, j) => (j === i ? e.target.value : s)))}
          />
          {!disabled && (
            <button
              type="button"
              aria-label="Remove step"
              className="text-[15px] text-[#b6bcc5] hover:text-danger"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              ×
            </button>
          )}
        </div>
      ))}
      {!disabled && (
        <div className="flex items-center gap-2">
          <span className="text-faint">☐</span>
          <input
            className={cn(rowCls, "placeholder:text-faint")}
            placeholder={placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            onBlur={add}
          />
        </div>
      )}
    </div>
  );
}

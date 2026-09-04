import type { Periodicity } from "@shared/schema/enums";
import { Input, Select } from "@/shared/ui/field";
import { pillCls } from "@/shared/ui/pill";

export const RHYTHM_LABEL: Record<Periodicity, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
  once: "Once",
};
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const dayLabel = (d: number) => (d === -1 ? "last day" : `day ${d}`);

export interface RhythmValue {
  periodicity: Periodicity;
  dayOfPeriod: number | null;
  monthOfPeriod: number | null;
  deadlineOffsetDays: number | null;
  estimatedMinutes: number | null;
}

/** Human-readable rhythm summary (catalog rows + per-client task lists). */
export function rhythmSummary(t: {
  periodicity: Periodicity;
  dayOfPeriod: number | null;
  monthOfPeriod: number | null;
  deadlineOffsetDays: number | null;
  estimatedMinutes: number | null;
}): string {
  const { periodicity, dayOfPeriod: day, monthOfPeriod: month } = t;
  const when =
    periodicity === "weekly"
      ? (day && WEEKDAYS[day - 1]) || null
      : periodicity === "monthly"
        ? day != null
          ? dayLabel(day)
          : null
        : periodicity === "quarterly"
          ? [
              month ? `${["1st", "2nd", "3rd"][month - 1]} month` : null,
              day != null ? dayLabel(day) : null,
            ]
              .filter(Boolean)
              .join(", ")
          : periodicity === "yearly"
            ? [month ? MONTHS[month - 1] : null, day != null ? dayLabel(day) : null]
                .filter(Boolean)
                .join(" ")
            : null;
  return [
    RHYTHM_LABEL[periodicity],
    when || null,
    t.deadlineOffsetDays != null ? `deadline +${t.deadlineOffsetDays}d` : null,
    t.estimatedMinutes != null ? `~${t.estimatedMinutes} min` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

const DEADLINE_PRESETS = [1, 2, 5] as const;

/**
 * The free-entry boxes beside the preset pills: what each one SHOWS, and what a typed string
 * MEANS. They are a pair, and the pair is the contract — a controlled input re-renders from state
 * after every keystroke, so a box that does not echo its own value eats what you type.
 *
 * Both boxes used to blank themselves whenever the number happened to match a pill. Typing "15"
 * therefore put 1 in state, the box cleared, and the "5" started a fresh number: you got day 5.
 * The deadline box was worse — "12" left it empty with "+2 days" lit, so the reader asked for 12
 * days and silently got 2 (user, 2026-09-04). Every value a box accepts must survive a round trip
 * through it; `rhythm-boxes.test.ts` types into them to prove it.
 *
 * "Last day" (-1) is the one value the pill owns outright: it is not a number anyone types into a
 * 1–31 box, so the box stays empty and the pill carries it.
 */
export const dayBoxValue = (day: number | null) => (day != null && day > 0 ? String(day) : "");
/** Empty means the 1st — `calendarDay` reads a null day that way, and the "1st" pill lights up. */
export const dayFromBox = (text: string): number => (text ? Number(text) : 1);
export const offsetBoxValue = (offset: number | null) => (offset == null ? "" : String(offset));
/** Empty means no deadline at all, which is the "none" pill. */
export const offsetFromBox = (text: string): number | null => (text ? Number(text) : null);

/** Rhythm + deadline + planned-time controls; controlled by a RhythmValue + onChange(patch).
 * `oneTime` = job-preset mode: no rhythm (periodicity is always "once"), only deadline + time. */
export function TaskRhythmFields({
  value,
  onChange,
  dayError,
  plannedHint,
  oneTime,
}: {
  value: RhythmValue;
  onChange: (patch: Partial<RhythmValue>) => void;
  dayError?: string;
  plannedHint?: string;
  oneTime?: boolean;
}) {
  const { periodicity, dayOfPeriod: day, monthOfPeriod: month, deadlineOffsetDays: offset } = value;

  return (
    <>
      {!oneTime && (
      <div>
        <div className="mb-1.5 block text-[12px] font-medium text-ink-700">Rhythm / frequency</div>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(RHYTHM_LABEL) as Periodicity[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => {
                // sensible defaults per frequency
                if (p === "once") onChange({ periodicity: p, dayOfPeriod: null, monthOfPeriod: null });
                else if (p === "weekly" || p === "monthly")
                  onChange({ periodicity: p, dayOfPeriod: 1, monthOfPeriod: null });
                else onChange({ periodicity: p, dayOfPeriod: 1, monthOfPeriod: 1 });
              }}
              className={pillCls(periodicity === p)}
            >
              {RHYTHM_LABEL[p]}
            </button>
          ))}
        </div>

        {periodicity === "weekly" && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[13px]">
            <span>On</span>
            {WEEKDAYS.map((w, i) => (
              <button
                key={w}
                type="button"
                onClick={() => onChange({ dayOfPeriod: i + 1 })}
                className={pillCls(day === i + 1)}
              >
                {w}
              </button>
            ))}
          </div>
        )}

        {periodicity === "quarterly" && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[13px]">
            <span>In the</span>
            {[1, 2, 3].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onChange({ monthOfPeriod: m })}
                className={pillCls(month === m)}
              >
                {["1st", "2nd", "3rd"][m - 1]}
              </button>
            ))}
            <span>month of the quarter</span>
          </div>
        )}

        {periodicity === "yearly" && (
          <div className="mt-2 flex items-center gap-2 text-[13px]">
            <span>In</span>
            <Select
              className="w-28"
              value={month ?? 1}
              onChange={(e) => onChange({ monthOfPeriod: Number(e.target.value) })}
            >
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </Select>
          </div>
        )}

        {(periodicity === "monthly" || periodicity === "quarterly" || periodicity === "yearly") && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[13px]">
            <span>On</span>
            <button type="button" onClick={() => onChange({ dayOfPeriod: 1 })} className={pillCls(day === 1)}>
              1st
            </button>
            <button type="button" onClick={() => onChange({ dayOfPeriod: 15 })} className={pillCls(day === 15)}>
              15th
            </button>
            <button type="button" onClick={() => onChange({ dayOfPeriod: -1 })} className={pillCls(day === -1)}>
              Last day
            </button>
            <Input
              className="w-16"
              type="number"
              min={1}
              max={31}
              placeholder="day"
              value={dayBoxValue(day)}
              onChange={(e) => onChange({ dayOfPeriod: dayFromBox(e.target.value) })}
            />
            {dayError && <span className="text-[12px] text-danger-text">{dayError}</span>}
          </div>
        )}
      </div>
      )}

      <div>
        <div className="mb-1.5 block text-[12px] font-medium text-ink-700">
          {oneTime
            ? "Deadline preset — days after the job is created"
            : "Deadline (offset from each task’s creation date)"}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {DEADLINE_PRESETS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => onChange({ deadlineOffsetDays: d })}
              className={pillCls(offset === d)}
            >
              +{d} days
            </button>
          ))}
          <button
            type="button"
            onClick={() => onChange({ deadlineOffsetDays: null })}
            className={pillCls(offset == null)}
          >
            none
          </button>
          <Input
            className="w-16"
            type="number"
            min={0}
            max={90}
            // "flex" read as a mode the box was in; it is simply the number of days, and now that
            // it echoes the pills it has to say so
            placeholder="days"
            value={offsetBoxValue(offset)}
            onChange={(e) => onChange({ deadlineOffsetDays: offsetFromBox(e.target.value) })}
          />
        </div>
      </div>

      <div className="flex items-center gap-2 text-[13px]">
        <span>Planned time</span>
        <Input
          className="w-20"
          type="number"
          min={1}
          placeholder="min"
          value={value.estimatedMinutes ?? ""}
          onChange={(e) =>
            onChange({ estimatedMinutes: e.target.value ? Number(e.target.value) : null })
          }
        />
        <span className="text-muted">minutes{plannedHint ? ` — ${plannedHint}` : ""}</span>
      </div>
    </>
  );
}

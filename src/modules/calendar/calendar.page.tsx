import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Bell, CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import type { DeadlineItem, Meeting } from "@shared/schema/calendar";
import { useAssignees } from "@/modules/tasks";
import { cn } from "@/shared/lib/cn";
import { userLabel } from "@/shared/ui/avatar";
import { Button } from "@/shared/ui/button";
import { Segmented } from "@/shared/ui/segmented";
import { FilterChips } from "@/shared/ui/tabs";
import { useCalendar, useMeeting } from "./calendar.api";
import { MeetingModal } from "./meeting-modal";
import {
  DAY_END_HOUR,
  DAY_START_HOUR,
  OPENING_HOUR,
  addDays,
  columnsFor,
  dayOfMeeting,
  firmToday,
  fmtRange,
  fmtTime,
  isoDay,
  placeInGrid,
  slotInstant,
  splitOverflow,
  startOfMonth,
  windowFor,
  type ViewMode,
} from "./grid";

/**
 * The shared calendar (S8).
 *
 * Two lanes, deliberately never mixed: **meetings** are instants and live in the hour grid;
 * **deadlines** are whole calendar days and live in the all-day row above it. A deadline drawn at
 * a time would be inventing information the task never carried.
 *
 * The deadline lane is read-only on purpose. The board is where work is done, and a second place
 * to edit a task is a second place for the two to disagree — from here you click through.
 */

const VIEWS: { value: ViewMode; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_CELL_ROWS = 4;
/**
 * How many deadlines a day of the lane shows before it starts counting instead.
 *
 * A week is seven narrow columns and the lane is reference material sitting on top of the hour
 * grid, so it stays short. A day is one column somebody opened deliberately, so it stretches a
 * little — the height of a row is the same in both, this is about what the view is for.
 */
const DUE_ROWS_WEEK = 3;
const DUE_ROWS_DAY = 5;

export function CalendarPage() {
  const [mode, setMode] = useState<ViewMode>("week");
  // the firm's today, not the viewer's: near midnight the two are different days, and the
  // week drawn must be the week the office is in
  const [anchor, setAnchor] = useState(() => dayFromIso(firmToday()));
  const [userId, setUserId] = useState<string | undefined>();
  const [lanes, setLanes] = useState({ meetings: true, deadlines: true });
  const [formOpen, setFormOpen] = useState<{ startAt?: string; id?: string } | null>(null);
  /** the meeting just saved — scrolled to once it has been drawn */
  const [justSaved, setJustSaved] = useState<string | null>(null);

  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: team } = useAssignees();

  /**
   * `?meeting=<id>` — where a notification's Open lands (S9).
   *
   * The param is CONSUMED, not merely read: it opens the meeting, moves the view to the day it is
   * actually on, and then removes itself from the URL. Left in place it would reopen the modal
   * every time the person navigated back to the calendar, and — worse — a meeting notification
   * about a move would keep dragging the view to that day.
   *
   * `replace` so the back button goes where the person came from rather than to the same link.
   */
  const meetingParam = searchParams.get("meeting");
  const { data: linkedMeeting } = useMeeting(meetingParam ?? undefined);
  useEffect(() => {
    if (!meetingParam || !linkedMeeting) return;
    setFormOpen({ id: meetingParam });
    setAnchor(new Date(linkedMeeting.startAt));
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("meeting");
        return next;
      },
      { replace: true },
    );
  }, [meetingParam, linkedMeeting, setSearchParams]);

  const { from, to, days } = windowFor(mode, anchor);
  const { data, isLoading, error } = useCalendar({ from, to, userId, ...lanes });

  const step = (dir: 1 | -1) =>
    setAnchor((a) =>
      mode === "month"
        ? new Date(a.getFullYear(), a.getMonth() + dir, 1)
        : addDays(a, dir * (mode === "week" ? 7 : 1)),
    );

  const meetingsByDay = groupBy(data?.meetings ?? [], (m) => dayOfMeeting(m.startAt));

  // the card is drawn on the render after the list refetches, so the scroll waits for it to exist
  useEffect(() => {
    if (!justSaved) return;
    const card = document.querySelector(`[data-meeting-id="${justSaved}"]`);
    if (!card) return;
    card.scrollIntoView({ block: "center", behavior: "smooth" });
    const timer = setTimeout(() => setJustSaved(null), 2000);
    return () => clearTimeout(timer);
  }, [justSaved, data]);
  const deadlinesByDay = groupBy(data?.deadlines ?? [], (d) => d.day);

  const title =
    mode === "month"
      ? anchor.toLocaleDateString("en-GB", { month: "long", year: "numeric" })
      : mode === "week"
        ? `${days[0].toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} – ${days[6].toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}`
        : anchor.toLocaleDateString("en-GB", {
            weekday: "long",
            day: "2-digit",
            month: "long",
            year: "numeric",
          });

  return (
    <div className="mx-auto max-w-[1320px]">
      <div className="mb-3.5 flex flex-wrap items-center gap-3">
        <h1 className="text-[20px] font-semibold">Calendar</h1>
        <div className="flex items-center gap-1">
          <IconButton label="Previous" onClick={() => step(-1)}>
            <ChevronLeft size={16} />
          </IconButton>
          <IconButton label="Next" onClick={() => step(1)}>
            <ChevronRight size={16} />
          </IconButton>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setAnchor(dayFromIso(firmToday()))}
          >
            Today
          </Button>
        </div>
        <span className="whitespace-nowrap text-[13px] font-medium text-muted">{title}</span>
        <div className="ml-auto flex items-center gap-3">
          <Segmented value={mode} onChange={setMode} options={VIEWS} />
          <Button onClick={() => setFormOpen({})}>+ New meeting</Button>
        </div>
      </div>

      <div className="mb-3.5 flex flex-wrap items-center gap-3">
        <FilterChips
          value={userId ?? "all"}
          onChange={(v) => setUserId(v === "all" ? undefined : v)}
          options={[
            { value: "all", label: "Everyone" },
            ...(team ?? []).map((u) => ({ value: u.id, label: userLabel(u) })),
          ]}
        />
        {/* Real toggles with counts, not a legend. They used to be two dots and a caption in the
            far corner, which reads as decoration — nobody realised a lane could be switched off,
            and nothing on the screen said how much was on it (user, 2026-08-06). */}
        <div className="ml-auto flex items-center gap-2">
          <LaneToggle
            on={lanes.meetings}
            swatch="bg-[#c3cdf3]"
            label="Meetings"
            count={data?.meetings.length}
            onClick={() => setLanes((l) => ({ ...l, meetings: !l.meetings }))}
          />
          <LaneToggle
            on={lanes.deadlines}
            swatch="bg-[#e8c99a]"
            label="Deadlines"
            count={data?.deadlines.length}
            onClick={() => setLanes((l) => ({ ...l, deadlines: !l.deadlines }))}
          />
        </div>
      </div>

      {error && <p className="text-[13px] text-danger-text">Couldn't load the calendar.</p>}
      {isLoading && !data && (
        <div className="h-[520px] animate-pulse rounded-(--radius-panel) border border-border bg-surface" />
      )}

      {data && mode === "month" && (
        <MonthGrid
          days={days}
          anchorMonth={startOfMonth(anchor).getMonth()}
          meetingsByDay={meetingsByDay}
          deadlinesByDay={deadlinesByDay}
          onOpenDay={(d) => {
            setAnchor(d);
            setMode("day");
          }}
          onOpenMeeting={(id) => setFormOpen({ id })}
          onOpenTask={(taskId) => navigate(`/tasks?task=${taskId}`)}
        />
      )}

      {data && mode !== "month" && (
        <TimeGrid
          days={days}
          meetingsByDay={meetingsByDay}
          deadlinesByDay={deadlinesByDay}
          onOpenMeeting={(id) => setFormOpen({ id })}
          onOpenTask={(taskId) => navigate(`/tasks?task=${taskId}`)}
          onPickSlot={(startAt) => setFormOpen({ startAt })}
          onOpenDay={
            mode === "week"
              ? (d) => {
                  setAnchor(d);
                  setMode("day");
                }
              : undefined
          }
        />
      )}

      <p className="mt-2.5 text-[12px] text-faint">
        Deadlines are shown for reference and open the task — work on them from the Tasks board.
      </p>

      {formOpen && (
        <MeetingModal
          meetingId={formOpen.id}
          defaultStartAt={formOpen.startAt}
          onClose={() => setFormOpen(null)}
          onSaved={(m) => {
            // Take the person to what they just saved. A meeting booked for 23:57 lands in a row
            // far below the fold — the calendar looked unchanged and it read as "nothing was
            // created", which is the only sensible conclusion from a silent screen
            // (user, 2026-08-06).
            setAnchor(dayFromIso(dayOfMeeting(m.startAt)));
            setJustSaved(m.id);
          }}
        />
      )}
    </div>
  );
}

/** "YYYY-MM-DD" → a Date carrying just those calendar parts, for the grid's day arithmetic. */
function dayFromIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) (out[key(item)] ??= []).push(item);
  return out;
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-(--radius-card) border border-[#d9dde3] bg-surface text-muted hover:bg-divider"
    >
      {children}
    </button>
  );
}

/** A chip that both explains a lane's colour and switches it off — and says how much is on it. */
function LaneToggle({
  on,
  swatch,
  label,
  count,
  onClick,
}: {
  on: boolean;
  swatch: string;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      title={on ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
      className={cn(
        "flex items-center gap-1.5 rounded-(--radius-chip) border px-2.5 py-1 text-[12px]",
        on
          ? "border-[#d9dde3] bg-surface text-ink-700"
          : "border-transparent bg-divider text-faint line-through",
      )}
    >
      <span className={cn("h-2.5 w-2.5 rounded-sm", on ? swatch : "bg-[#cfd4da]")} />
      {label}
      {count !== undefined && (
        <span className={cn("text-[11px]", on ? "text-muted-400" : "text-faint")}>{count}</span>
      )}
    </button>
  );
}

// ── month ────────────────────────────────────────────────────────────────────

function MonthGrid({
  days,
  anchorMonth,
  meetingsByDay,
  deadlinesByDay,
  onOpenDay,
  onOpenMeeting,
  onOpenTask,
}: {
  days: Date[];
  anchorMonth: number;
  meetingsByDay: Record<string, Meeting[]>;
  deadlinesByDay: Record<string, DeadlineItem[]>;
  onOpenDay: (d: Date) => void;
  onOpenMeeting: (id: string) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const todayIso = firmToday();
  return (
    <div className="overflow-hidden rounded-(--radius-panel) border border-border bg-surface">
      <div className="grid grid-cols-7 border-b border-border bg-[#fafbfc] text-[11px] font-medium uppercase tracking-wide text-muted-400">
        {WEEKDAYS.map((d) => (
          <div key={d} className="px-3 py-2">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((day) => {
          const key = isoDay(day);
          const meetings = meetingsByDay[key] ?? [];
          const deadlines = deadlinesByDay[key] ?? [];
          const outside = day.getMonth() !== anchorMonth;
          // a cell fits a few rows; whatever does not fit is COUNTED, never dropped in silence.
          // Deriving `hidden` from what was actually rendered is the point — the previous version
          // compared against a fixed 5 and hid a 4th deadline without a word.
          const shownDeadlines = deadlines.slice(0, MONTH_CELL_ROWS);
          const shownMeetings = meetings.slice(0, MONTH_CELL_ROWS - shownDeadlines.length);
          const hidden =
            meetings.length + deadlines.length - shownMeetings.length - shownDeadlines.length;
          return (
            <div
              key={key}
              className={cn(
                "min-h-[104px] border-r border-b border-[#f2f4f7] p-1.5 last:border-r-0",
                outside && "bg-[#fbfcfd]",
              )}
            >
              <button
                type="button"
                onClick={() => onOpenDay(day)}
                className={cn(
                  "mb-1 flex h-5 w-5 items-center justify-center rounded-full text-[12px]",
                  key === todayIso
                    ? "bg-primary font-semibold text-white"
                    : outside
                      ? "text-faint"
                      : "text-muted hover:bg-divider",
                )}
              >
                {day.getDate()}
              </button>
              <div className="space-y-0.5">
                {shownDeadlines.map((d) => (
                  <DeadlineChip key={d.taskId} item={d} onClick={() => onOpenTask(d.taskId)} />
                ))}
                {shownMeetings.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => onOpenMeeting(m.id)}
                    className="block w-full truncate rounded-[4px] bg-[#e8ecfb] px-1.5 py-0.5 text-left text-[11px] text-primary-link"
                  >
                    {fmtTime(m.startAt)} {m.title}
                  </button>
                ))}
                {hidden > 0 && (
                  <button
                    type="button"
                    onClick={() => onOpenDay(day)}
                    className="px-1.5 text-[11px] text-faint hover:underline"
                  >
                    +{hidden} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── day + week ───────────────────────────────────────────────────────────────

function TimeGrid({
  days,
  meetingsByDay,
  deadlinesByDay,
  onOpenMeeting,
  onOpenTask,
  onPickSlot,
  onOpenDay,
}: {
  days: Date[];
  meetingsByDay: Record<string, Meeting[]>;
  deadlinesByDay: Record<string, DeadlineItem[]>;
  onOpenMeeting: (id: string) => void;
  onOpenTask: (taskId: string) => void;
  onPickSlot: (startAt: string) => void;
  /** undefined in the day view — there is nothing narrower to open */
  onOpenDay?: (day: Date) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // open on the working day; a meeting outside it is a scroll, not a surprise
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = (OPENING_HOUR / (DAY_END_HOUR - DAY_START_HOUR)) * el.scrollHeight;
  }, []);

  const todayIso = firmToday();
  const hours = Array.from(
    { length: DAY_END_HOUR - DAY_START_HOUR },
    (_, i) => DAY_START_HOUR + i,
  );
  const anyDeadlines = days.some((d) => (deadlinesByDay[isoDay(d)] ?? []).length > 0);

  /**
   * The whole lane opens, not one column of it.
   *
   * It is one CSS grid row, so its height is the tallest cell in it — expanding a single day
   * would grow the band anyway. Seven pieces of state for one visible outcome is not a choice
   * worth offering.
   *
   * A day gives the lane more room than a week does, and someone who opened one day did it to
   * look at that day. The row itself costs the same height either way, so this is about intent
   * rather than width.
   */
  const dueCap = days.length === 1 ? DUE_ROWS_DAY : DUE_ROWS_WEEK;
  const [dueOpen, setDueOpen] = useState(false);
  // reset on any move: opening the lane is a peek at one day, never a mode to be left in.
  // Not a remount via `key` — that would re-run the scroll above and throw away the hour the
  // person had scrolled to.
  const range = `${days.length}:${isoDay(days[0])}`;
  useEffect(() => setDueOpen(false), [range]);

  return (
    <div className="overflow-hidden rounded-(--radius-panel) border border-border bg-surface">
      {/* day headers */}
      <div
        className="grid border-b border-border bg-[#fafbfc]"
        style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0,1fr))` }}
      >
        <div />
        {days.map((d) => {
          const key = isoDay(d);
          const inner = (
            <>
              <div className="text-[11px] uppercase tracking-wide text-muted-400">
                {WEEKDAYS[(d.getDay() + 6) % 7]}
              </div>
              <div
                className={cn(
                  "text-[15px] font-semibold",
                  key === todayIso ? "text-primary" : "text-ink-700",
                )}
              >
                {d.getDate()}
              </div>
            </>
          );
          // A week column is ~180px, which holds about 28 characters; a generated task title is
          // more than twice that. Widening the page buys six characters and breaks step with every
          // other screen — the day view is where a full title actually fits, so the header is the
          // way in (user, 2026-08-06: keep it consistent, expand instead).
          return onOpenDay ? (
            <button
              key={key}
              type="button"
              onClick={() => onOpenDay(d)}
              title="Open this day in full width"
              className="border-l border-[#f2f4f7] px-3 py-2 text-left hover:bg-divider/50"
            >
              {inner}
            </button>
          ) : (
            <div key={key} className="border-l border-[#f2f4f7] px-3 py-2">
              {inner}
            </div>
          );
        })}
      </div>

      {/* all-day lane: deadlines are whole days and belong nowhere in the hour grid */}
      {anyDeadlines && (
        <div
          className="grid border-b border-border bg-[#fffdf8]"
          style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0,1fr))` }}
        >
          <div className="px-2 py-1.5 text-right text-[10px] font-medium uppercase tracking-wide text-[#8a5a12]">
            Due
          </div>
          {days.map((d) => {
            const all = deadlinesByDay[isoDay(d)] ?? [];
            const { shown, hidden } = splitOverflow(all, dueOpen ? all.length : dueCap);
            // the toggle belongs on exactly the days that were cut — nowhere else has anything
            // to say, and a day of two deadlines should not carry a control about nine
            const truncatable = all.length > dueCap + 1;
            return (
              <div key={isoDay(d)} className="space-y-1 border-l border-[#f2f4f7] p-1.5">
                {shown.map((item) => (
                  <DeadlineChip
                    key={item.taskId}
                    item={item}
                    onClick={() => onOpenTask(item.taskId)}
                  />
                ))}
                {truncatable && (
                  <button
                    type="button"
                    onClick={() => setDueOpen((v) => !v)}
                    className="px-1 text-[11px] text-[#8a5a12] hover:underline"
                  >
                    {hidden > 0 ? `+${hidden} more` : "− less"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* The hour grid scrolls inside the panel. A full day is 24 rows; the view opens on the
          working hours so the ordinary case looks ordinary, and anything early or late is a scroll
          away rather than clamped to an edge or off the bottom of the page. */}
      <div ref={scrollRef} className="max-h-[62vh] overflow-y-auto">
        <div
          className="relative grid"
          style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0,1fr))` }}
        >
          <div>
            {hours.map((h) => (
              <div
                key={h}
                className="h-[52px] border-b border-[#f4f6f8] pr-2 pt-1 text-right text-[11px] text-faint"
              >
                {String(h).padStart(2, "0")}:00
              </div>
            ))}
          </div>
          {days.map((d) => {
            const key = isoDay(d);
            const laid = columnsFor(meetingsByDay[key] ?? []);
            return (
              <div key={key} className="relative border-l border-[#f2f4f7]">
                {hours.map((h) => (
                  <button
                    key={h}
                    type="button"
                    aria-label={`New meeting at ${String(h).padStart(2, "0")}:00`}
                    onClick={() => onPickSlot(slotInstant(key, h))}
                    className="block h-[52px] w-full border-b border-[#f4f6f8] hover:bg-[#f7f9fc]"
                  />
                ))}
                {laid.map(({ item, column, columns }) => {
                  const pos = placeInGrid(item.startAt, item.durationMinutes);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-meeting-id={item.id}
                      onClick={() => onOpenMeeting(item.id)}
                      style={{
                        top: `${pos.topPct}%`,
                        height: `${pos.heightPct}%`,
                        left: `${(column / columns) * 100}%`,
                        width: `${100 / columns}%`,
                      }}
                      title={`${fmtRange(item.startAt, item.durationMinutes)} · ${item.title}${
                        (item.clientName ?? item.leadName)
                          ? ` · ${item.clientName ?? item.leadName}`
                          : ""
                      }${
                        item.remindMinutesBefore
                          ? ` · reminder ${item.remindMinutesBefore} min before`
                          : ""
                      }`}
                      className="absolute overflow-hidden rounded-[6px] border border-[#c3cdf3] bg-[#e8ecfb] px-1.5 py-0.5 text-left leading-tight"
                    >
                      {/* A short meeting gets ONE line — the box is only tall enough for one, and
                        three lines in it rendered as clipped nonsense. The time leads, because in
                        a column of boxes that is what you scan for. */}
                      {pos.compact ? (
                        // the one-line card, which is MOST of them — this firm books short
                        // check-ins, so leaving the bell off the compact variant meant leaving it
                        // off the common case (caught in testing)
                        <div className="flex items-center gap-1 truncate text-[11px] text-primary-link">
                          <span className="font-semibold">{fmtTime(item.startAt)}</span>
                          {item.remindMinutesBefore !== null && (
                            <Bell size={9} className="shrink-0" aria-hidden />
                          )}
                          <span className="truncate">{item.title}</span>
                        </div>
                      ) : (
                        <>
                          <div className="truncate text-[10px] font-medium text-muted">
                            {pos.clippedStart && "↑ "}
                            {fmtRange(item.startAt, item.durationMinutes)}
                            {pos.clippedEnd && " ↓"}
                          </div>
                          <div className="flex items-center gap-1 truncate text-[11px] font-semibold text-primary-link">
                            {/* a reminder is invisible otherwise until somebody opens the form —
                                and "did I set one?" is the question you ask the day before */}
                            {item.remindMinutesBefore !== null && (
                              <Bell size={9} className="shrink-0" aria-hidden />
                            )}
                            <span className="truncate">{item.title}</span>
                          </div>
                          {(item.clientName ?? item.leadName) && (
                            <div className="truncate text-[10px] text-muted-400">
                              {item.clientName ?? item.leadName}
                            </div>
                          )}
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DeadlineChip({ item, onClick }: { item: DeadlineItem; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={item.title}
      className={cn(
        "flex w-full items-center gap-1 truncate rounded-[4px] px-1.5 py-0.5 text-left text-[11px]",
        item.overdue ? "bg-danger-soft text-danger-text" : "bg-[#fdf3e2] text-[#8a5a12]",
      )}
    >
      <CalendarDays size={10} strokeWidth={2} className="flex-none" />
      <span className="truncate">{item.title}</span>
    </button>
  );
}

import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { fmtDate } from "@/shared/lib/format";
import { Button } from "@/shared/ui/button";
import { useMeetingsFor } from "./calendar.api";
import { MeetingModal } from "./meeting-modal";
import { fmtRange } from "./grid";

/**
 * One client's or one lead's meetings — the rollup on their card.
 *
 * Cancelled meetings stay listed and flagged. They leave the calendar because they no longer
 * occupy a slot, but "we arranged that and called it off" is part of the history of a
 * relationship, and the card is where that history is read.
 */
export function EntityMeetings({
  target,
}: {
  target: { kind: "client" | "lead"; id: string };
}) {
  const filter = target.kind === "client" ? { clientId: target.id } : { leadId: target.id };
  const { data, isLoading, error } = useMeetingsFor(filter);
  const [open, setOpen] = useState<{ id?: string } | null>(null);

  const now = Date.now();
  const upcoming = (data ?? []).filter((m) => !m.cancelledAt && new Date(m.startAt).getTime() >= now);
  const past = (data ?? []).filter((m) => m.cancelledAt || new Date(m.startAt).getTime() < now);

  return (
    <div className="rounded-(--radius-panel) border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
        <h2 className="text-[15px] font-semibold">Meetings</h2>
        <Button size="sm" onClick={() => setOpen({})}>
          📅 Schedule meeting
        </Button>
      </div>

      {error && <p className="px-5 py-4 text-[13px] text-danger-text">Couldn't load meetings.</p>}
      {isLoading && <p className="px-5 py-4 text-[13px] text-muted">Loading…</p>}

      {data && data.length === 0 && (
        <div className="px-5 py-10 text-center">
          <CalendarDays size={24} strokeWidth={1.5} className="mx-auto text-faint" />
          <p className="mt-2 text-[13px] text-muted">No meetings yet.</p>
        </div>
      )}

      {upcoming.length > 0 && (
        <Group title="Upcoming" items={upcoming} onOpen={(id) => setOpen({ id })} />
      )}
      {past.length > 0 && <Group title="Past" items={past} onOpen={(id) => setOpen({ id })} />}

      {open && (
        <MeetingModal
          meetingId={open.id}
          defaultClientId={target.kind === "client" ? target.id : undefined}
          defaultLeadId={target.kind === "lead" ? target.id : undefined}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function Group({
  title,
  items,
  onOpen,
}: {
  title: string;
  items: {
    id: string;
    title: string;
    startAt: string;
    durationMinutes: number;
    cancelledAt: string | null;
  }[];
  onOpen: (id: string) => void;
}) {
  return (
    <div>
      <div className="border-b border-[#f2f4f7] bg-[#fafbfc] px-5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-400">
        {title}
      </div>
      {items.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onOpen(m.id)}
          className="flex w-full items-center gap-3 border-b border-[#f2f4f7] px-5 py-2.5 text-left text-[13px] last:border-b-0 hover:bg-divider/40"
        >
          <span className={cn("min-w-0 flex-1 truncate font-medium", m.cancelledAt && "line-through text-faint")}>
            {m.title}
          </span>
          {m.cancelledAt && (
            <span className="flex-none rounded-(--radius-chip) bg-divider px-2 py-0.5 text-[11px] text-muted">
              called off
            </span>
          )}
          <span className="flex-none text-[12px] text-muted">
            {fmtDate(m.startAt)} · {fmtRange(m.startAt, m.durationMinutes)}
          </span>
        </button>
      ))}
    </div>
  );
}

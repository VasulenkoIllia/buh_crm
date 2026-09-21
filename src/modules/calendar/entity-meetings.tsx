import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { useCanEdit } from "@/app/auth";
import { cn } from "@/shared/lib/cn";
import { fmtDate } from "@/shared/lib/format";
import { Button } from "@/shared/ui/button";
import { CopyLink } from "@/shared/ui/copy-link";
import { RowButton } from "@/shared/ui/row-button";
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
  bare = false,
}: {
  target: { kind: "client" | "lead"; id: string };
  /**
   * A section of a card that is already one panel: no frame of its own, a small heading, a text
   * action and bordered rows like the tasks beside it. The lead card (variant A, owner 2026-09-18);
   * the client card's tab keeps the panel.
   */
  bare?: boolean;
}) {
  const filter = target.kind === "client" ? { clientId: target.id } : { leadId: target.id };
  const { data, isLoading, error } = useMeetingsFor(filter);
  const [open, setOpen] = useState<{ id?: string } | null>(null);
  // Calendar read-only: the meetings are listed, booking one is not offered (the server would
  // refuse it anyway). Found by the audit of the lead card, 2026-09-18.
  const canBook = useCanEdit("calendar");

  const now = Date.now();
  const upcoming = (data ?? []).filter(
    (m) => !m.cancelledAt && new Date(m.startAt).getTime() >= now,
  );
  const past = (data ?? []).filter((m) => m.cancelledAt || new Date(m.startAt).getTime() < now);

  const modal = open && (
    <MeetingModal
      meetingId={open.id}
      defaultClientId={target.kind === "client" ? target.id : undefined}
      defaultLeadId={target.kind === "lead" ? target.id : undefined}
      onClose={() => setOpen(null)}
    />
  );

  if (bare) {
    return (
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[13px] font-semibold">
            Meetings
            {!!data?.length && (
              <span className="ml-1.5 font-normal text-muted">{data.length}</span>
            )}
          </h3>
          {canBook && (
            <Button variant="text" size="sm" className="px-0" onClick={() => setOpen({})}>
              + Schedule meeting
            </Button>
          )}
        </div>
        {error && <p className="text-[13px] text-danger-text">Couldn't load meetings.</p>}
        {isLoading && <p className="text-[13px] text-muted">Loading…</p>}
        {data && data.length === 0 && (
          <p className="text-[13px] text-muted">No meetings yet.</p>
        )}
        {[...upcoming, ...past].map((m) => {
          const gone = !upcoming.includes(m);
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => setOpen({ id: m.id })}
              className={cn(
                "mb-1.5 flex w-full items-center gap-2 rounded-[8px] border border-border bg-surface px-3 py-2 text-left text-[13px] hover:bg-divider/30",
                gone && "opacity-70",
              )}
            >
              <span
                className={cn(
                  "min-w-0 flex-1 truncate font-medium",
                  m.cancelledAt && "text-faint line-through",
                )}
              >
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
          );
        })}
        {modal}
      </div>
    );
  }

  return (
    <div className="rounded-(--radius-panel) border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
        <h2 className="text-[15px] font-semibold">Meetings</h2>
        {canBook && (
          <Button size="sm" onClick={() => setOpen({})}>
            📅 Schedule meeting
          </Button>
        )}
      </div>

      {error && (
        <p className="px-5 py-4 text-[13px] text-danger-text">Couldn't load meetings.</p>
      )}
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

      {modal}
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
        <div
          key={m.id}
          className="flex items-center gap-2 border-b border-divider px-5 last:border-b-0"
        >
          <RowButton
            onClick={() => onOpen(m.id)}
            className="-mx-2 gap-3 rounded-(--radius-field) px-2 py-2.5 text-[13px]"
          >
            <span
              className={cn(
                "min-w-0 flex-1 truncate font-medium",
                m.cancelledAt && "line-through text-faint",
              )}
            >
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
          </RowButton>
          {/* the same copy button every record has, in the row rather than only in the modal
            (owner, 2026-09-21: "і з задач і інвойсів самого клієнта") */}
          <CopyLink href={`/calendar?meeting=${m.id}`} label="Copy link to this meeting" />
        </div>
      ))}
    </div>
  );
}

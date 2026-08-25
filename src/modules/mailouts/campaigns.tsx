import { useEffect, useRef, useState } from "react";
import { CalendarClock, CalendarDays, Pause, Pencil, Play, Repeat } from "lucide-react";
import type { Campaign } from "@shared/schema/campaigns";
import { RHYTHM_LABELS } from "@shared/campaigns";
import { cn } from "@/shared/lib/cn";
import { fmtBizDate, fmtDate, fmtDateTime } from "@/shared/lib/format";
import { IconButton } from "@/shared/ui/button";
import { CampaignModal } from "./campaign-modal";
import { CampaignDetailModal } from "./campaign-detail";
import { useCampaigns, useSetCampaignActive } from "./mailouts.api";

/**
 * Every track a fixed width except the first — no `auto`, no second `fr`.
 *
 * Each row is its own grid container, so a content-sized track is measured against THAT row: the
 * header's "Status" (45px) against the body's pill + pause + Edit (150px). Every column left of it
 * then landed in a different place on the header than in the rows, which is exactly what made this
 * table look broken while every value in it was right.
 */
const GRID = "grid-cols-[minmax(180px,1fr)_130px_120px_150px_80px_170px]";
/** the tracks add up to 830 + five 12px gaps — say the real number, not a smaller comfortable one */
const MIN = "min-w-[890px]";

/**
 * The Campaigns tab — letters the firm has planned but not yet sent.
 *
 * The Sent tab answers "what went out". This one answers "what is about to", which is the only
 * question a schedule can be judged on: a campaign nobody can see the next date of is a campaign
 * nobody trusts.
 */
export function Campaigns({ newSignal }: { newSignal: number }) {
  const { data, isLoading } = useCampaigns();
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setActive = useSetCampaignActive();

  /**
   * A CHANGE in the signal opens the editor — never the signal's mere presence.
   *
   * The page header owns the "New …" button and passes a counter down. Switching tabs unmounts
   * this list, so a plain `> 0` check fired again on the way back: leave the tab and return, and
   * the editor opened by itself. Seeding the ref from the incoming value makes a mount a no-op.
   */
  const handled = useRef(newSignal);
  useEffect(() => {
    if (newSignal === handled.current) return;
    handled.current = newSignal;
    setCreating(true);
  }, [newSignal]);

  const items = data?.items ?? [];

  return (
    <>
      {/* The app's global handler only acts on 401, so a refused stop/start — "there are no dates
          left", say — went nowhere at all. A control that can fail must have somewhere to say so. */}
      {error && (
        <p className="mb-3 rounded-(--radius-field) bg-danger/10 px-3 py-2 text-[13px] text-danger-text">
          {error}
        </p>
      )}

      {isLoading ? (
        <p className="text-[13px] text-muted">Loading…</p>
      ) : items.length === 0 ? (
        <div className="rounded-(--radius-panel) border border-dashed border-[#cfd4db] bg-surface p-12 text-center">
          <div className="text-[15px] font-semibold">Nothing scheduled</div>
          <p className="mt-1 text-[13px] text-muted">
            A campaign is a saved template, a list of clients and a date — it goes out on its
            own, once or on a rhythm.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-(--radius-panel) border border-border bg-surface">
          <div
            className={cn(
              "grid items-center gap-x-3 border-b border-border px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-faint",
              MIN,
              GRID,
            )}
          >
            <div>Campaign</div>
            <div>Template</div>
            <div>Rhythm</div>
            <div>Next</div>
            <div>Recipients</div>
            <div className="text-right">Status</div>
          </div>

          {items.map((c) => (
            <div
              key={c.id}
              onClick={() => setOpen(c.id)}
              className={cn(
                "grid cursor-pointer items-center gap-x-3 border-b border-border px-4 py-2.5 text-[13px] last:border-0 hover:bg-[#fafbfc]",
                MIN,
                GRID,
              )}
            >
              <div className="min-w-0">
                <div className="truncate">{c.name}</div>
                {c.kind === "transactional" && (
                  <span className="text-[11px] text-muted">Transactional — no unsubscribe</span>
                )}
              </div>
              <div className="truncate text-muted">{c.templateName}</div>
              <div className="flex items-center gap-1 whitespace-nowrap text-muted">
                {c.rhythm !== "once" && c.rhythm !== "dates" && (
                  <Repeat size={11} className="shrink-0" />
                )}
                {c.rhythm === "dates" && <CalendarDays size={11} className="shrink-0" />}
                {c.rhythm === "dates"
                  ? `${c.dates.length} date${c.dates.length === 1 ? "" : "s"}`
                  : RHYTHM_LABELS[c.rhythm]}
              </div>
              <div className="whitespace-nowrap text-muted">
                {c.nextRunOn ? (
                  <span className="flex items-center gap-1">
                    <CalendarClock size={11} className="shrink-0" />
                    {fmtBizDate(c.nextRunOn)}
                    <span className="text-faint">{c.sendAt}</span>
                  </span>
                ) : c.lastRunAt ? (
                  <span title={fmtDateTime(c.lastRunAt)}>Last sent {fmtDate(c.lastRunAt)}</span>
                ) : (
                  "—"
                )}
              </div>
              <div className="whitespace-nowrap text-muted">
                {c.recipientCount}
                {c.runCount > 0 && <span className="text-faint"> · {c.runCount}×</span>}
              </div>
              {/* The quiet icon strip every list in this app uses — 28×28, grey at rest, meaning
                  in the tooltip. Hand-rolled buttons and a text "Edit" here made this row the only
                  one in the product that looked different (see IconButton's own comment). */}
              <div
                className="flex items-center justify-end gap-1"
                onClick={(e) => e.stopPropagation()}
              >
                <CampaignStatus campaign={c} />
                {c.status !== "finished" && (
                  <IconButton
                    label={
                      c.status === "scheduled"
                        ? "Stop — no more letters until it is started again"
                        : "Start again"
                    }
                    disabled={setActive.isPending}
                    onClick={() => {
                      setError(null);
                      setActive
                        .mutateAsync({ id: c.id, active: c.status !== "scheduled" })
                        .catch((e) =>
                          setError(e instanceof Error ? e.message : "Could not change it"),
                        );
                    }}
                  >
                    {c.status === "scheduled" ? <Pause size={15} /> : <Play size={15} />}
                  </IconButton>
                )}
                <IconButton label="Edit campaign" onClick={() => setEditing(c)}>
                  <Pencil size={15} />
                </IconButton>
              </div>
            </div>
          ))}
        </div>
      )}

      <CampaignModal open={creating} campaign={null} onClose={() => setCreating(false)} />
      <CampaignModal open={!!editing} campaign={editing} onClose={() => setEditing(null)} />
      <CampaignDetailModal id={open} onClose={() => setOpen(null)} />
    </>
  );
}

export function CampaignStatus({ campaign }: { campaign: { status: string } }) {
  const tone =
    campaign.status === "scheduled"
      ? "bg-success/12 text-success"
      : campaign.status === "stopped"
        ? "bg-warning/20 text-[#8a5a12]"
        : "bg-divider text-muted";
  const label =
    campaign.status === "scheduled"
      ? "Scheduled"
      : campaign.status === "stopped"
        ? "Stopped"
        : "Finished";
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", tone)}>
      {label}
    </span>
  );
}

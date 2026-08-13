import { useState } from "react";
import { CalendarClock, Pause, Play, Plus, Repeat } from "lucide-react";
import type { Campaign } from "@shared/schema/campaigns";
import { RHYTHM_LABELS } from "@shared/campaigns";
import { cn } from "@/shared/lib/cn";
import { fmtDate, fmtDateTime } from "@/shared/lib/format";
import { Button } from "@/shared/ui/button";
import { CampaignModal } from "./campaign-modal";
import { CampaignDetailModal } from "./campaign-detail";
import { useCampaigns, useSetCampaignActive } from "./mailouts.api";

const GRID = "grid-cols-[minmax(180px,1fr)_150px_120px_130px_110px_auto]";

/**
 * The Campaigns tab — letters the firm has planned but not yet sent.
 *
 * The Sent tab answers "what went out". This one answers "what is about to", which is the only
 * question a schedule can be judged on: a campaign nobody can see the next date of is a campaign
 * nobody trusts.
 */
export function Campaigns() {
  const { data, isLoading } = useCampaigns();
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const setActive = useSetCampaignActive();

  const items = data?.items ?? [];

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus size={14} /> New campaign
        </Button>
      </div>

      {isLoading ? (
        <p className="text-[13px] text-muted">Loading…</p>
      ) : items.length === 0 ? (
        <div className="rounded-(--radius-panel) border border-dashed border-[#cfd4db] bg-surface p-12 text-center">
          <div className="text-[15px] font-semibold">Nothing scheduled</div>
          <p className="mt-1 text-[13px] text-muted">
            A campaign is a saved template, a list of clients and a date — it goes out on its own,
            once or on a rhythm.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-(--radius-panel) border border-border bg-surface">
          <div
            className={cn(
              "grid min-w-[760px] items-center gap-x-3 border-b border-border px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-faint",
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
                "grid min-w-[760px] cursor-pointer items-center gap-x-3 border-b border-border px-4 py-2.5 text-[13px] last:border-0 hover:bg-[#fafbfc]",
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
              <div className="flex items-center gap-1 text-muted">
                {c.rhythm !== "once" && <Repeat size={11} />}
                {RHYTHM_LABELS[c.rhythm]}
              </div>
              <div className="text-muted">
                {c.nextRunOn ? (
                  <span className="flex items-center gap-1">
                    <CalendarClock size={11} />
                    {fmtDate(c.nextRunOn)} · {c.sendAt}
                  </span>
                ) : c.lastRunAt ? (
                  `Last sent ${fmtDateTime(c.lastRunAt)}`
                ) : (
                  "—"
                )}
              </div>
              <div className="text-muted">
                {c.recipientCount}
                {c.runCount > 0 && ` · sent ${c.runCount}×`}
              </div>
              <div className="flex items-center justify-end gap-2">
                <CampaignStatus campaign={c} />
                {c.status !== "finished" && (
                  <button
                    type="button"
                    title={c.status === "scheduled" ? "Stop" : "Start again"}
                    onClick={(e) => {
                      e.stopPropagation();
                      setActive.mutate({ id: c.id, active: c.status !== "scheduled" });
                    }}
                    className="rounded p-1 text-muted hover:bg-divider hover:text-ink"
                  >
                    {c.status === "scheduled" ? <Pause size={13} /> : <Play size={13} />}
                  </button>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditing(c);
                  }}
                  className="text-[12px] text-primary-link hover:underline"
                >
                  Edit
                </button>
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
    campaign.status === "scheduled" ? "Scheduled" : campaign.status === "stopped" ? "Stopped" : "Finished";
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", tone)}>{label}</span>
  );
}

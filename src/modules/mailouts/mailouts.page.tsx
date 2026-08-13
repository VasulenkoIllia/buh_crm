import { useEffect, useRef, useState } from "react";
import { Pencil, Plus, Power, Send, Trash2 } from "lucide-react";
import type { EmailTemplate } from "@shared/schema/mailouts";
import { cn } from "@/shared/lib/cn";
import { fmtDateTime } from "@/shared/lib/format";
import { Button, IconButton } from "@/shared/ui/button";
import { Tabs } from "@/shared/ui/tabs";
import { Campaigns } from "./campaigns";
import { ComposeModal } from "./compose-modal";
import { MailoutDetailModal } from "./mailout-detail";
import { SenderSettings } from "./sender-settings";
import { StatusPill } from "./status-pill";
import { TemplateModal } from "./template-modal";
import { useDeleteTemplate, useMailouts, useTemplates, useUpdateTemplate } from "./mailouts.api";

/**
 * Written in the project's own visual language rather than a private one: `mx-auto max-w-[…]` with
 * no extra padding (the app layout already gives `p-6`), a 20px semibold h1, `--radius-panel`
 * surfaces, and grid rows instead of `<table>` — the shape Billing and Clients use.
 *
 * The header follows Clients and Billing exactly: **one row** of h1 + a short inline note + the
 * primary action pinned right. It used to be a title row plus a paragraph whose length changed
 * with the tab, so the tabs — and everything under them — sat at a different height on every tab.
 * A screen that moves when you switch tabs reads as a different screen each time.
 */
const TABS = [
  { value: "log" as const, label: "Sent" },
  { value: "campaigns" as const, label: "Campaigns" },
  { value: "templates" as const, label: "Templates" },
  { value: "sender" as const, label: "Sender" },
];
type Tab = (typeof TABS)[number]["value"];

/**
 * One line each, and one line is the point.
 *
 * These sit between the tabs and the panel, so a two-line one on a single tab would push that
 * tab's content down and no other's — the exact jump this rewrite removes. Anything that needs
 * more than a line belongs next to the control it explains, where it can be read in context.
 */
const BLURB: Record<Tab, string> = {
  log: "Every letter that went out, and what happened to each recipient — skipped ones included.",
  campaigns: "Letters planned for a date rather than sent by hand — once, or on a rhythm.",
  templates: "A letter you send more than once, personalised per client. Only the words change.",
  sender: "Which mailboxes letters go from, and the firm's details that appear in every one.",
};

/** One primary action per tab, always in the same place — never one in the header and one below. */
const ACTION: Record<Tab, string | null> = {
  log: "New mailout",
  campaigns: "New campaign",
  templates: "New template",
  sender: null,
};

export function MailoutsPage() {
  const [tab, setTab] = useState<Tab>("log");
  const [composing, setComposing] = useState(false);
  const [openMailout, setOpenMailout] = useState<string | null>(null);
  // the tab-level "new" buttons live in the header now, so the tabs own a signal rather than a button
  const [newCampaign, setNewCampaign] = useState(0);
  const [newTemplate, setNewTemplate] = useState(0);

  const act = () => {
    if (tab === "log") setComposing(true);
    if (tab === "campaigns") setNewCampaign((n) => n + 1);
    if (tab === "templates") setNewTemplate((n) => n + 1);
  };

  return (
    <div className="mx-auto max-w-[960px]">
      {/* `min-h-9` is the Button's own height: without it the Sender tab, which has no action,
          sat 8px shorter and moved the tabs — the jump this whole rewrite is about. */}
      <div className="mb-3.5 flex min-h-9 flex-wrap items-center gap-3.5">
        <h1 className="text-[20px] font-semibold">Mailouts</h1>
        <span className="text-[13px] text-muted-400">{BLURB[tab]}</span>
        {ACTION[tab] && (
          <Button className="ml-auto shrink-0" onClick={act}>
            {tab === "log" ? <Send size={14} /> : <Plus size={14} />}
            {ACTION[tab]}
          </Button>
        )}
      </div>

      <Tabs className="mb-4" value={tab} onChange={setTab} options={TABS} />

      {tab === "log" && <SentLog onOpen={setOpenMailout} />}
      {tab === "campaigns" && <Campaigns newSignal={newCampaign} />}
      {tab === "templates" && <TemplateList newSignal={newTemplate} />}
      {tab === "sender" && <SenderSettings />}

      <ComposeModal
        open={composing}
        onClose={() => setComposing(false)}
        onSent={(id) => setOpenMailout(id)}
      />
      <MailoutDetailModal id={openMailout} onClose={() => setOpenMailout(null)} />
    </div>
  );
}

/** The project's empty state: dashed, roomy, one line of what to do about it. */
function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="rounded-(--radius-panel) border border-dashed border-[#cfd4db] bg-surface p-12 text-center">
      <div className="text-[15px] font-semibold">{title}</div>
      <p className="mt-1 text-[13px] text-muted">{hint}</p>
    </div>
  );
}

// ── the log ──────────────────────────────────────────────────────────────────

/**
 * Every track a fixed width except the first.
 *
 * Each row is its own grid container, so an `auto` or `fr` track is measured against THAT row's
 * content — the header's "Recipients" against the body's row of pills. The columns then land in
 * different places on every line, which is what made the Campaigns table read as broken.
 */
const LOG_GRID = "grid-cols-[minmax(200px,1fr)_150px_130px_140px_170px]";
const LOG_MIN = "min-w-[840px]";

function SentLog({ onOpen }: { onOpen: (id: string) => void }) {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useMailouts({ page, pageSize: 25 });

  if (isLoading) return <p className="text-[13px] text-muted">Loading…</p>;
  if (!data || data.items.length === 0) {
    return (
      <Empty
        title="Nothing has been sent yet"
        hint="A mailout you send will appear here with what happened to every recipient."
      />
    );
  }

  const pages = Math.ceil(data.total / 25);

  return (
    <>
      <div className="overflow-x-auto rounded-(--radius-panel) border border-border bg-surface">
        <div
          className={cn(
            "grid items-center gap-x-3 border-b border-border px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-faint",
            LOG_MIN,
            LOG_GRID,
          )}
        >
          <div>Subject</div>
          <div>Template</div>
          <div>Sent by</div>
          <div>When</div>
          <div className="text-right">Recipients</div>
        </div>

        {data.items.map((m) => (
          <div
            key={m.id}
            onClick={() => onOpen(m.id)}
            className={cn(
              "grid cursor-pointer items-center gap-x-3 border-b border-border px-4 py-2.5 text-[13px] last:border-0 hover:bg-[#fafbfc]",
              LOG_MIN,
              LOG_GRID,
            )}
          >
            <div className="min-w-0">
              <span className="truncate">{m.subject}</span>
              {m.kind === "transactional" && (
                <span className="ml-2 rounded-(--radius-chip) bg-[#eef0f3] px-1.5 py-0.5 text-[10px] text-muted">
                  transactional
                </span>
              )}
            </div>
            <div className="truncate text-muted">{m.templateName ?? "One-off letter"}</div>
            <div className="truncate text-muted">{m.createdByName ?? "—"}</div>
            <div className="whitespace-nowrap text-muted">{fmtDateTime(m.createdAt)}</div>
            <div className="flex justify-end gap-1.5">
              {m.counts.sent > 0 && <StatusPill status="sent" count={m.counts.sent} />}
              {m.counts.queued > 0 && <StatusPill status="queued" count={m.counts.queued} />}
              {m.counts.failed > 0 && <StatusPill status="failed" count={m.counts.failed} />}
              {m.counts.skipped > 0 && <StatusPill status="skipped" count={m.counts.skipped} />}
            </div>
          </div>
        ))}
      </div>

      {pages > 1 && (
        <div className="mt-3 flex items-center justify-end gap-2 text-[12px]">
          <Button
            size="sm"
            variant="secondary"
            disabled={page === 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <span className="text-muted">
            {page} / {pages}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </>
  );
}

// ── templates ────────────────────────────────────────────────────────────────

/**
 * `newSignal` is a counter, not a boolean.
 *
 * The header owns the "New template" button now, and the editor lives here with the list it edits.
 * A boolean would need clearing after every open, and would silently fail the second time it was
 * pressed; a rising number cannot get stuck.
 */
function TemplateList({ newSignal }: { newSignal: number }) {
  const { data, isLoading } = useTemplates();
  const update = useUpdateTemplate();
  const remove = useDeleteTemplate();
  const [editing, setEditing] = useState<EmailTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function tryDelete(t: EmailTemplate) {
    setError(null);
    try {
      await remove.mutateAsync(t.id);
    } catch (e) {
      // the server refuses when a mailout still points at it — show that reason, don't swallow it
      setError(e instanceof Error ? e.message : "Could not delete the template");
    }
  }

  return (
    <>
      {error && (
        <p className="mb-3 rounded-(--radius-field) bg-danger/10 px-3 py-2 text-[13px] text-danger-text">
          {error}
        </p>
      )}

      {isLoading ? (
        <p className="text-[13px] text-muted">Loading…</p>
      ) : !data || data.length === 0 ? (
        <Empty
          title="No templates yet"
          hint="Create the first one — or send a one-off letter without a template from “New mailout”."
        />
      ) : (
        <div className="overflow-hidden rounded-(--radius-panel) border border-border bg-surface">
          {data.map((t) => (
            <div
              key={t.id}
              className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[14px] font-medium">{t.name}</span>
                  {!t.active && (
                    <span className="rounded-(--radius-chip) bg-[#eef0f3] px-1.5 py-0.5 text-[10px] text-muted">
                      inactive
                    </span>
                  )}
                  {t.kind === "transactional" && (
                    <span className="rounded-(--radius-chip) bg-[#eef0f3] px-1.5 py-0.5 text-[10px] text-muted">
                      transactional
                    </span>
                  )}
                </div>
                <p className="truncate text-[13px] text-muted">{t.subject}</p>
              </div>
              {/* The quiet icon strip, same as Services and the client card. Three text links per
                  row put four repeated words on every line and pulled the eye off the template
                  they act on — the reason IconButton exists (see its comment). */}
              <div className="flex flex-none items-center gap-1">
                <IconButton label="Edit template" onClick={() => setEditing(t)}>
                  <Pencil size={15} />
                </IconButton>
                <IconButton
                  label={
                    t.active
                      ? "Deactivate — it stays in history but cannot be sent or scheduled"
                      : "Activate"
                  }
                  disabled={update.isPending}
                  className={t.active ? "hover:text-danger" : undefined}
                  onClick={() => update.mutate({ id: t.id, input: { active: !t.active } })}
                >
                  <Power size={15} />
                </IconButton>
                <IconButton
                  label="Delete template"
                  disabled={remove.isPending}
                  className="hover:text-danger"
                  onClick={() => tryDelete(t)}
                >
                  <Trash2 size={15} />
                </IconButton>
              </div>
            </div>
          ))}
        </div>
      )}

      <TemplateModal open={creating} template={null} onClose={() => setCreating(false)} />
      <TemplateModal open={!!editing} template={editing} onClose={() => setEditing(null)} />
    </>
  );
}

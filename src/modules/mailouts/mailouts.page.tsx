import { useState } from "react";
import { Pencil, Send } from "lucide-react";
import type { EmailTemplate } from "@shared/schema/mailouts";
import { cn } from "@/shared/lib/cn";
import { fmtDateTime } from "@/shared/lib/format";
import { Button } from "@/shared/ui/button";
import { Tabs } from "@/shared/ui/tabs";
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
 */
const TABS = [
  { value: "log" as const, label: "Sent" },
  { value: "templates" as const, label: "Templates" },
  { value: "sender" as const, label: "Sender" },
];
type Tab = (typeof TABS)[number]["value"];

const BLURB: Record<Tab, string> = {
  log: "Every letter that went out, and what happened to each recipient — including the ones that were skipped, and why.",
  templates:
    "A template is a letter you send more than once, personalised per client. The frame — logo, signature, contact buttons, footer — is the same on all of them; only the subject, heading and body change.",
  sender: "Which mailboxes letters go from, and the firm's details that appear in every one.",
};

export function MailoutsPage() {
  const [tab, setTab] = useState<Tab>("log");
  const [composing, setComposing] = useState(false);
  const [openMailout, setOpenMailout] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-[960px]">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-[20px] font-semibold">Mailouts</h1>
        <Button onClick={() => setComposing(true)}>
          <Send size={14} /> New mailout
        </Button>
      </div>
      <p className="mb-3 text-[13px] text-muted-400">{BLURB[tab]}</p>

      <Tabs className="mb-4" value={tab} onChange={setTab} options={TABS} />

      {tab === "log" && <SentLog onOpen={setOpenMailout} />}
      {tab === "templates" && <TemplateList />}
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

const LOG_GRID = "grid-cols-[minmax(220px,1fr)_150px_130px_140px_auto]";

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
            "grid min-w-[760px] items-center gap-x-3 border-b border-border px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-faint",
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
              "grid min-w-[760px] cursor-pointer items-center gap-x-3 border-b border-border px-4 py-2.5 text-[13px] last:border-0 hover:bg-[#fafbfc]",
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
            <div className="text-muted">{fmtDateTime(m.createdAt)}</div>
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

function TemplateList() {
  const { data, isLoading } = useTemplates();
  const update = useUpdateTemplate();
  const remove = useDeleteTemplate();
  const [editing, setEditing] = useState<EmailTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <div className="mb-3 flex justify-end">
        <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
          + New template
        </Button>
      </div>

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
              <Button size="sm" variant="text" onClick={() => setEditing(t)}>
                <Pencil size={13} /> Edit
              </Button>
              <Button
                size="sm"
                variant="text"
                onClick={() => update.mutate({ id: t.id, input: { active: !t.active } })}
              >
                {t.active ? "Deactivate" : "Activate"}
              </Button>
              <Button size="sm" variant="text" onClick={() => tryDelete(t)}>
                Delete
              </Button>
            </div>
          ))}
        </div>
      )}

      <TemplateModal open={creating} template={null} onClose={() => setCreating(false)} />
      <TemplateModal open={!!editing} template={editing} onClose={() => setEditing(null)} />
    </>
  );
}

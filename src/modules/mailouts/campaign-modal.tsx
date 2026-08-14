import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Building2, Search, Trash2, X } from "lucide-react";
import type { Campaign, CampaignInput } from "@shared/schema/campaigns";
import type { MailoutTarget } from "@shared/schema/mailouts";
import { useClients } from "@/modules/clients";
import { cn } from "@/shared/lib/cn";
import { fmtDate } from "@/shared/lib/format";
import { Button } from "@/shared/ui/button";
import { FormField, Input, Select } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { Segmented } from "@/shared/ui/segmented";
import {
  useCampaign,
  useCreateCampaign,
  useDeleteCampaign,
  useMailSenders,
  useTemplates,
  useUpdateCampaign,
} from "./mailouts.api";

const PICKER_PAGE_SIZE = 100;

const keyOf = (clientId: string, companyId: string | null) =>
  companyId ? `${clientId}:${companyId}` : clientId;

function toTarget(key: string): MailoutTarget {
  const [clientId, companyId] = key.split(":");
  return companyId ? { clientId, companyId } : { clientId };
}

/**
 * Planning a campaign: what letter, to whom, and when.
 *
 * The list is picked by hand and stored, not described by a rule — so the firm can see exactly who
 * is queued up, and edit that list right up to the date. A rule would mean nobody knows who was
 * about to be written to until after it happened.
 */
export function CampaignModal({
  open,
  campaign,
  onClose,
}: {
  open: boolean;
  /** null = a new one */
  campaign: Campaign | null;
  onClose: () => void;
}) {
  const templates = useTemplates();
  const senders = useMailSenders();
  const existing = useCampaign(open && campaign ? campaign.id : null);
  const create = useCreateCampaign();
  const update = useUpdateCampaign();
  const remove = useDeleteCampaign();

  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [senderAccountId, setSenderAccountId] = useState("");
  const [kind, setKind] = useState<"commercial" | "transactional">("commercial");
  const [rhythm, setRhythm] = useState<CampaignInput["rhythm"]>("once");
  const [startsOn, setStartsOn] = useState("");
  const [sendAt, setSendAt] = useState("09:00");
  const [endsOn, setEndsOn] = useState("");
  const [dates, setDates] = useState<string[]>([]);
  const [newDate, setNewDate] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  const clients = useClients(
    { tab: "all", search: search || undefined, pageSize: PICKER_PAGE_SIZE },
    { enabled: open },
  );

  /**
   * The loaded campaign, held in a ref so the reset effect can read it WITHOUT depending on it.
   *
   * `refetchOnWindowFocus` is on app-wide, and every campaign mutation invalidates this query, so
   * the detail object's identity changes often. As a dependency it reset the form each time —
   * alt-tab away while editing and everything typed was gone. The effect keys on the campaign's
   * ID instead: that changes when a DIFFERENT campaign is opened, which is the only time a reset
   * is wanted.
   */
  const latest = useRef(existing.data);
  latest.current = existing.data;

  const loadedId = existing.data?.id ?? null;
  useEffect(() => {
    if (!open) return;
    const c = latest.current;
    setName(c?.name ?? "");
    setTemplateId(c?.templateId ?? "");
    setSenderAccountId(c?.senderAccountId ?? "");
    setKind(c?.kind ?? "commercial");
    setRhythm(c?.rhythm ?? "once");
    setStartsOn(c?.startsOn ?? new Date().toISOString().slice(0, 10));
    setSendAt(c?.sendAt ?? "09:00");
    setEndsOn(c?.endsOn ?? "");
    setDates(c?.dates ?? []);
    setNewDate("");
    setSelected(new Set(c?.recipients.map((r) => keyOf(r.clientId, r.companyId)) ?? []));
    setSearch("");
    setError(null);
  }, [open, loadedId]);

  const activeTemplates = useMemo(
    () => (templates.data ?? []).filter((t) => t.active),
    [templates.data],
  );

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function save() {
    setError(null);
    const input: CampaignInput = {
      name: name.trim(),
      templateId,
      senderAccountId: senderAccountId || null,
      kind,
      rhythm,
      sendAt,
      // a list ends by running out; only a rule needs a stop date
      endsOn: rhythm === "once" || rhythm === "dates" || !endsOn ? null : endsOn,
      // `startsOn` is derived from the list server-side, but send the earliest anyway so the
      // request is self-consistent rather than relying on the server to repair it
      startsOn: rhythm === "dates" ? (dates.slice().sort()[0] ?? startsOn) : startsOn,
      dates: rhythm === "dates" ? dates : undefined,
      recipients: [...selected].map(toTarget),
    };
    try {
      if (campaign) await update.mutateAsync({ id: campaign.id, input });
      else await create.mutateAsync(input);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the campaign");
    }
  }

  async function drop() {
    if (!campaign) return;
    setError(null);
    try {
      await remove.mutateAsync(campaign.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the campaign");
    }
  }

  const visible = clients.data?.items ?? [];
  const ready =
    name.trim() &&
    templateId &&
    selected.size > 0 &&
    (rhythm === "dates" ? dates.length > 0 : !!startsOn);

  function addDate() {
    const d = newDate.trim();
    if (!d || dates.includes(d)) return;
    setDates((prev) => [...prev, d].sort());
    setNewDate("");
  }
  const busy = create.isPending || update.isPending || remove.isPending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={campaign ? "Edit campaign" : "New campaign"}
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {campaign && (
              <button
                type="button"
                onClick={drop}
                disabled={busy}
                className="flex items-center gap-1 text-[12px] text-danger-text hover:underline"
              >
                <Trash2 size={12} /> Delete
              </button>
            )}
            <p className="text-[12px] text-muted">
              {selected.size} recipient{selected.size === 1 ? "" : "s"}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={save} disabled={!ready || busy}>
              {busy ? "Saving…" : campaign ? "Save" : "Schedule it"}
            </Button>
          </div>
        </div>
      }
    >
      {error && (
        <p className="mb-3 rounded-(--radius-field) bg-danger/10 px-3 py-2 text-[13px] text-danger-text">
          {error}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-3">
          <p className="text-[12px] font-medium uppercase tracking-wide text-muted">What</p>
          <FormField label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tax season reminder"
            />
          </FormField>
          <FormField label="Template">
            <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Pick a template…</option>
              {activeTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Mailbox">
            <Select value={senderAccountId} onChange={(e) => setSenderAccountId(e.target.value)}>
              <option value="">As the template says</option>
              {(senders.data?.accounts ?? [])
                .filter((a) => a.active)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {a.fromEmail ?? "no address"}
                  </option>
                ))}
            </Select>
          </FormField>

          <Segmented
            value={kind}
            onChange={(v) => setKind(v as "commercial" | "transactional")}
            options={[
              { value: "commercial", label: "Commercial" },
              { value: "transactional", label: "Transactional" },
            ]}
          />
          {/* Stated where the choice is made, not in a doc nobody opens: this is the one setting
              on the screen that decides whether a client who asked to be left alone gets a letter. */}
          {kind === "transactional" ? (
            <p className="flex gap-1.5 rounded-(--radius-field) bg-warning/15 px-3 py-2 text-[12px] leading-relaxed text-[#8a5a12]">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>
                This will reach clients who unsubscribed, and carries no unsubscribe link. Lawful
                for a bill or a document request — not for news or offers.
              </span>
            </p>
          ) : (
            <p className="text-[12px] leading-relaxed text-muted">
              Carries an unsubscribe link and the firm&apos;s postal address, and skips anyone who
              has opted out.
            </p>
          )}

          <p className="pt-1 text-[12px] font-medium uppercase tracking-wide text-muted">When</p>
          <FormField label="Schedule">
            <Select
              value={rhythm}
              onChange={(e) => setRhythm(e.target.value as CampaignInput["rhythm"])}
            >
              <option value="once">Once, on a date</option>
              <option value="dates">On set dates</option>
              <option value="monthly">Every month</option>
              <option value="quarterly">Every quarter</option>
              <option value="yearly">Every year</option>
            </Select>
          </FormField>

          {/* A hand-picked list rather than a rule: an accounting calendar is 15 March, 15 April,
              15 September — deadlines, not a rhythm, and bending them into "every quarter" would
              be a lie the schedule then acts on. */}
          {rhythm === "dates" ? (
            <>
              <div className="grid grid-cols-[1fr_auto_120px] items-end gap-2">
                <FormField label="Add a date">
                  <Input
                    type="date"
                    value={newDate}
                    onChange={(e) => setNewDate(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addDate();
                      }
                    }}
                  />
                </FormField>
                <Button variant="secondary" onClick={addDate} disabled={!newDate}>
                  Add
                </Button>
                <FormField label="Time">
                  <Input type="time" value={sendAt} onChange={(e) => setSendAt(e.target.value)} />
                </FormField>
              </div>
              {dates.length === 0 ? (
                <p className="text-[12px] text-muted">
                  No dates yet — the campaign goes out once on each one you add.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {dates.map((d) => (
                    <span
                      key={d}
                      className="inline-flex items-center gap-1.5 rounded-(--radius-chip) bg-[#eef0f3] py-1 pl-2.5 pr-1.5 text-[12px] text-ink"
                    >
                      {fmtDate(d)}
                      <button
                        type="button"
                        aria-label={`Remove ${fmtDate(d)}`}
                        className="text-muted hover:text-danger"
                        onClick={() => setDates((prev) => prev.filter((x) => x !== d))}
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <FormField label={rhythm === "once" ? "Date" : "First date"}>
                  <Input
                    type="date"
                    value={startsOn}
                    onChange={(e) => setStartsOn(e.target.value)}
                  />
                </FormField>
                <FormField label="Time">
                  <Input type="time" value={sendAt} onChange={(e) => setSendAt(e.target.value)} />
                </FormField>
              </div>
              {rhythm !== "once" && (
                <FormField label="Stop after (optional)">
                  <Input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
                </FormField>
              )}
            </>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-[12px] font-medium uppercase tracking-wide text-muted">To whom</p>
          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search clients…"
              className="pl-8"
            />
          </div>

          <div className="max-h-[420px] overflow-y-auto rounded-(--radius-field) border border-border">
            {clients.isLoading ? (
              <p className="p-3 text-[13px] text-muted">Loading…</p>
            ) : visible.length === 0 ? (
              <p className="p-3 text-[13px] text-faint">No clients match.</p>
            ) : (
              visible.map((c) => (
                <div key={c.id} className="border-b border-divider last:border-0">
                  <Row
                    name={c.displayName}
                    email={c.email}
                    checked={selected.has(c.id)}
                    onToggle={() => toggle(c.id)}
                  />
                  {c.companies.map((co) => (
                    <Row
                      key={co.id}
                      name={co.name}
                      email={co.email}
                      nested
                      checked={selected.has(keyOf(c.id, co.id))}
                      onToggle={() => toggle(keyOf(c.id, co.id))}
                    />
                  ))}
                </div>
              ))
            )}
          </div>
          <p className="text-[12px] text-muted">
            Who is on the list is checked again on the day — anyone who has unsubscribed or lost
            their address by then is skipped, with the reason recorded.
          </p>
        </div>
      </div>
    </Modal>
  );
}

function Row({
  name,
  email,
  checked,
  onToggle,
  nested = false,
}: {
  name: string;
  email: string | null;
  checked: boolean;
  onToggle: () => void;
  nested?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-divider/50",
        nested && "border-l-2 border-divider pl-6",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="size-3.5 accent-[var(--color-primary)]"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-ink">
          {nested && <Building2 size={11} className="mr-1 inline text-faint" />}
          {name}
        </span>
        <span className="block truncate text-[12px] text-muted">{email ?? "no email address"}</span>
      </span>
    </label>
  );
}

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Building2, Check, Search } from "lucide-react";
import type {
  EmailTemplate,
  MailoutPreview,
  MailoutPreviewRow,
  MailoutTarget,
  SendMailoutInput,
} from "@shared/schema/mailouts";
import { useClients } from "@/modules/clients";
import { useCatalog } from "@/modules/catalog";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { FormField, Input, Select, Textarea } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { Segmented } from "@/shared/ui/segmented";
import { useMailSenders, usePreviewMailout, useSendMailout, useTemplates } from "./mailouts.api";

/** The list is long; ask the server rather than filtering a page of 25 in the browser. */
const PICKER_PAGE_SIZE = 100;

type Step = "who" | "check";

/**
 * One addressee, flattened to a string so the picker can hold them all in one Set.
 *
 * A client and each of that client's companies are separate addressees with separate inboxes, and
 * the picker has to be able to hold "Olena, and Kvitka Trade, but not Sonyachny FOP". Encoding the
 * pair rather than keeping two structures means selection, counting and the payload all read off
 * the same thing.
 */
const keyOf = (clientId: string, companyId: string | null) =>
  companyId ? `${clientId}:${companyId}` : clientId;

function toTarget(key: string): MailoutTarget {
  const [clientId, companyId] = key.split(":");
  return companyId ? { clientId, companyId } : { clientId };
}

/**
 * The composer — four answers, then a check.
 *
 *   WHAT       a saved template, or a one-off letter typed here
 *   TO WHOM    clients picked by hand; never "everyone", which is a campaign
 *   FROM WHERE a mailbox; blank means the template's, else the firm's default
 *   WHEN       now. Scheduling is not built, and the screen says so rather than implying it.
 *
 * Then the second step, which is the point: **nothing is sent before somebody has seen the letter
 * and the list of who will not get it**. The preview names every blocked recipient and why — no
 * address, unsubscribed, a `{{variable}}` their card has no value for — so a send of 40 that
 * reaches 37 says so up front instead of in a support call three weeks later.
 */
export function ComposeModal({
  open,
  onClose,
  onSent,
  presetClientId,
  presetTargets,
}: {
  open: boolean;
  onClose: () => void;
  onSent: (mailoutId: string) => void;
  /** opening straight from a client card — that client starts selected */
  presetClientId?: string;
  /**
   * That client's inboxes, pinned above the search.
   *
   * Without it, reaching one of their companies would mean finding the client again in a list the
   * search pages at 100 — so opening the composer from a card would work for a firm with ninety
   * clients and quietly stop working at a hundred and one. The card already holds this list.
   */
  presetTargets?: { companyId: string | null; name: string; email: string | null }[];
}) {
  const templates = useTemplates();
  const services = useCatalog();
  const senders = useMailSenders();
  const preview = usePreviewMailout();
  const send = useSendMailout();

  const [step, setStep] = useState<Step>("who");
  const [mode, setMode] = useState<"template" | "letter">("template");
  const [templateId, setTemplateId] = useState<string>("");
  const [subject, setSubject] = useState("");
  const [heading, setHeading] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<"commercial" | "transactional">("commercial");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [serviceId, setServiceId] = useState("");
  // "" = let the server decide: the template's mailbox, else the firm's default
  const [senderAccountId, setSenderAccountId] = useState("");
  const [result, setResult] = useState<MailoutPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pinnedName = presetTargets?.[0]?.name;

  /**
   * Primitives, deliberately — never the array itself in the reset effect below.
   *
   * `presetTargets` comes from the client card's mail state, which is intentionally never cached
   * (a client can unsubscribe from their own inbox while nobody here has touched anything). Every
   * refetch hands down a NEW array, and an array in those deps would re-run the reset — wiping a
   * half-typed letter each time the window regained focus.
   */
  const hasPresetTargets = !!presetTargets;
  const presetHasOwnAddress = !!presetTargets?.some((t) => !t.companyId && t.email);
  const clients = useClients(
    { tab: "all", search: search || undefined, serviceId: serviceId || undefined, pageSize: PICKER_PAGE_SIZE },
    { enabled: open },
  );

  useEffect(() => {
    if (!open) return;
    setStep("who");
    setMode("template");
    setTemplateId("");
    setSubject("");
    setHeading("");
    setBody("");
    setKind("commercial");
    // preselect their own address only when there IS one — otherwise the composer opens with a
    // recipient it already knows cannot be reached, and the first thing it says is a refusal
    setSelected(
      new Set(
        presetClientId && (!hasPresetTargets || presetHasOwnAddress) ? [presetClientId] : [],
      ),
    );
    setSearch("");
    setServiceId("");
    setSenderAccountId("");
    setResult(null);
    setError(null);
  }, [open, presetClientId, hasPresetTargets, presetHasOwnAddress]);

  const activeTemplates = useMemo(
    () => (templates.data ?? []).filter((t) => t.active),
    [templates.data],
  );

  const payload: SendMailoutInput | null = useMemo(() => {
    if (selected.size === 0) return null;
    const recipients = [...selected].map(toTarget);
    const from = senderAccountId || undefined;
    if (mode === "template") {
      if (!templateId) return null;
      return { templateId, recipients, senderAccountId: from };
    }
    if (!subject.trim() || !body.trim()) return null;
    return {
      letter: { subject: subject.trim(), heading: heading.trim() || null, body: body.trim(), kind },
      recipients,
      senderAccountId: from,
    };
  }, [mode, templateId, subject, heading, body, kind, selected, senderAccountId]);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const visible = clients.data?.items ?? [];
  const allVisibleSelected = visible.length > 0 && visible.every((c) => selected.has(c.id));

  async function goToCheck() {
    if (!payload) return;
    setError(null);
    try {
      setResult(await preview.mutateAsync(payload));
      setStep("check");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not build the preview");
    }
  }

  async function confirmSend() {
    if (!payload) return;
    setError(null);
    try {
      const mailout = await send.mutateAsync(payload);
      onSent(mailout.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send");
    }
  }

  const chosenTemplate: EmailTemplate | undefined = activeTemplates.find((t) => t.id === templateId);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={step === "who" ? "New mailout" : "Check before sending"}
      footer={
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12px] text-muted">
            {step === "who" ? (
              <>
                {selected.size} recipient{selected.size === 1 ? "" : "s"} selected · sends{" "}
                <strong className="font-medium">now</strong>
              </>
            ) : result ? (
              <>
                {result.sendable} will be sent · {result.blocked} skipped · from{" "}
                <strong className="font-medium">{result.senderAccountName}</strong>
              </>
            ) : (
              ""
            )}
          </p>
          <div className="flex gap-2">
            {step === "check" ? (
              <>
                <Button variant="secondary" onClick={() => setStep("who")} disabled={send.isPending}>
                  Back
                </Button>
                <Button
                  onClick={confirmSend}
                  disabled={send.isPending || !result || result.sendable === 0}
                >
                  {send.isPending
                    ? "Sending…"
                    : `Send to ${result?.sendable ?? 0} recipient${result?.sendable === 1 ? "" : "s"}`}
                </Button>
              </>
            ) : (
              <>
                <Button variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button onClick={goToCheck} disabled={!payload || preview.isPending}>
                  {preview.isPending ? "Checking…" : "Check"}
                </Button>
              </>
            )}
          </div>
        </div>
      }
    >
      {error && (
        <p className="mb-3 rounded-(--radius-field) bg-danger/10 px-3 py-2 text-[13px] text-danger-text">
          {error}
        </p>
      )}

      {step === "who" ? (
        <div className="grid gap-4 md:grid-cols-2">
          {/* what to send */}
          <div className="space-y-3">
            <p className="text-[12px] font-medium uppercase tracking-wide text-muted">What</p>
            <Segmented
              value={mode}
              onChange={(v) => setMode(v as "template" | "letter")}
              options={[
                { value: "template", label: "Saved template" },
                { value: "letter", label: "One-off letter" },
              ]}
            />

            {mode === "template" ? (
              <>
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
                {chosenTemplate && (
                  <div className="rounded-(--radius-field) border border-border bg-surface p-3">
                    <p className="text-[12px] uppercase tracking-wide text-muted">Subject</p>
                    <p className="mb-2 text-[13px] font-medium text-ink">{chosenTemplate.subject}</p>
                    <p className="line-clamp-4 whitespace-pre-wrap text-[12px] leading-relaxed text-ink-700">
                      {chosenTemplate.body}
                    </p>
                  </div>
                )}
                {activeTemplates.length === 0 && !templates.isLoading && (
                  <p className="text-[12px] text-muted">
                    No active templates yet — create one, or write a one-off letter.
                  </p>
                )}
              </>
            ) : (
              <>
                <FormField label="Subject">
                  <Input
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="Your {{company}} filing is ready"
                  />
                </FormField>
                <FormField label="Heading (optional)">
                  <Input
                    value={heading}
                    onChange={(e) => setHeading(e.target.value)}
                    placeholder="Hello {{first_name}}"
                  />
                </FormField>
                <FormField label="Body">
                  <Textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    className="h-[150px]"
                    placeholder={"Dear {{first_name}},\n\n…"}
                  />
                </FormField>
                <Segmented
                  value={kind}
                  onChange={(v) => setKind(v as "commercial" | "transactional")}
                  options={[
                    { value: "commercial", label: "Commercial" },
                    { value: "transactional", label: "Transactional" },
                  ]}
                />
              </>
            )}

          {/* who it comes from — left on "as the template says" unless someone chooses */}
          <p className="pt-1 text-[12px] font-medium uppercase tracking-wide text-muted">
            From where
          </p>
          <FormField label="Mailbox">
            <Select
              value={senderAccountId}
              onChange={(e) => setSenderAccountId(e.target.value)}
            >
              <option value="">
                {mode === "template" ? "As the template says" : "The default mailbox"}
              </option>
              {(senders.data?.accounts ?? [])
                .filter((a) => a.active)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {a.fromEmail ?? "no address"}
                    {a.isDefault ? " (default)" : ""}
                  </option>
                ))}
            </Select>
          </FormField>
          </div>

          {/* who gets it */}
          <div className="space-y-2">
            <p className="text-[12px] font-medium uppercase tracking-wide text-muted">To whom</p>
            <div className="flex gap-2">
              <div className="relative flex-1">
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
              <Select
                value={serviceId}
                onChange={(e) => setServiceId(e.target.value)}
                className="w-[140px]"
              >
                <option value="">All services</option>
                {(services.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>

            {/* deliberately the clients' OWN addresses only — a bulk button that silently also
                wrote to every company would be a much bigger act than the label admits */}
            <button
              type="button"
              onClick={() =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  for (const c of visible) {
                    if (allVisibleSelected) next.delete(c.id);
                    else next.add(c.id);
                  }
                  return next;
                })
              }
              className="text-[12px] text-primary-link hover:underline"
              disabled={visible.length === 0}
            >
              {allVisibleSelected ? "Clear these" : `Select these ${visible.length}`}
            </button>

            {presetClientId && presetTargets && presetTargets.length > 0 && (
              <div className="rounded-(--radius-field) border border-border">
                <p className="border-b border-divider px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
                  {pinnedName}
                </p>
                {presetTargets.map((t) => (
                  <Addressee
                    key={t.companyId ?? "own"}
                    name={t.companyId ? t.name : "Their own address"}
                    email={t.email}
                    nested={!!t.companyId}
                    checked={selected.has(keyOf(presetClientId, t.companyId))}
                    onToggle={() => toggle(keyOf(presetClientId, t.companyId))}
                  />
                ))}
              </div>
            )}

            <div className="max-h-[330px] overflow-y-auto rounded-(--radius-field) border border-border">
              {clients.isLoading ? (
                <p className="p-3 text-[13px] text-muted">Loading…</p>
              ) : visible.length === 0 ? (
                <p className="p-3 text-[13px] text-faint">No clients match.</p>
              ) : (
                visible.map((c) => (
                  <div key={c.id} className="border-b border-divider last:border-0">
                    <Addressee
                      name={c.displayName}
                      email={c.email}
                      checked={selected.has(c.id)}
                      onToggle={() => toggle(c.id)}
                    />
                    {/* the client's companies, each its own inbox — indented, because they belong
                        to the client above and are not clients in their own right */}
                    {c.companies.map((co) => (
                      <Addressee
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
            {clients.data && clients.data.total > visible.length && (
              <p className="text-[12px] text-muted">
                Showing {visible.length} of {clients.data.total} — narrow the search to reach the
                rest.
              </p>
            )}
          </div>
        </div>
      ) : (
        result && <CheckStep preview={result} />
      )}
    </Modal>
  );
}

/**
 * Step two: **who is about to be written to, and who is not**.
 *
 * Deliberately not a preview of the letter. The letter has two places that answer "what does this
 * look like" — the template editor and the kind switcher's full-size view — and repeating it here
 * made the one question this screen exists for compete for attention with a picture. What cannot
 * be checked anywhere else is the list: forty picked, thirty-seven reachable, and the three
 * reasons why not.
 */
function CheckStep({ preview }: { preview: MailoutPreview }) {
  const going = preview.rows.filter((r) => !r.blockedReason);
  const blocked = preview.rows.filter((r) => r.blockedReason);

  return (
    <div className="space-y-4">
      <p className="rounded-(--radius-field) bg-surface px-3 py-2 text-[13px] text-ink">
        <span className="text-faint">Subject: </span>
        {preview.subject}
      </p>

      {preview.unknownVariables.length > 0 && (
        <div className="rounded-(--radius-field) bg-danger/10 px-3 py-2 text-[12px] text-danger-text">
          <AlertTriangle size={13} className="mr-1 inline" />
          Not real variables: {preview.unknownVariables.map((u) => `{{${u}}}`).join(", ")} — they
          will appear in the letter exactly as written.
        </div>
      )}

      <div className="flex gap-2">
        <div className="flex-1 rounded-(--radius-field) border border-border p-3">
          <p className="text-[20px] font-semibold text-success">{preview.sendable}</p>
          <p className="text-[12px] text-muted">will be sent</p>
        </div>
        <div className="flex-1 rounded-(--radius-field) border border-border p-3">
          <p className="text-[20px] font-semibold text-ink">{preview.blocked}</p>
          <p className="text-[12px] text-muted">skipped</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <p className="mb-1.5 text-[12px] font-medium text-ink-700">
            Will be sent — the last look before it leaves.
          </p>
          {going.length === 0 ? (
            <p className="rounded-(--radius-field) border border-dashed border-[#cfd4db] px-3 py-6 text-center text-[12px] text-faint">
              Nobody on this list can be reached.
            </p>
          ) : (
            <div className="max-h-[300px] overflow-y-auto rounded-(--radius-field) border border-border">
              {going.map((r) => (
                <RecipientRow key={`${r.clientId}:${r.companyId ?? ""}`} row={r} />
              ))}
            </div>
          )}
        </div>

        <div>
          <p className="mb-1.5 text-[12px] font-medium text-ink-700">
            Skipped — and why. Each is recorded in the log.
          </p>
          {blocked.length === 0 ? (
            <p className="flex items-center gap-1.5 rounded-(--radius-field) border border-dashed border-[#cfd4db] px-3 py-6 text-[12px] text-success">
              <Check size={14} /> Every selected recipient can be reached.
            </p>
          ) : (
            <div className="max-h-[300px] overflow-y-auto rounded-(--radius-field) border border-border">
              {blocked.map((r) => (
                <RecipientRow
                  key={`${r.clientId}:${r.companyId ?? ""}`}
                  row={r}
                  reason={r.blockedReason}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** One name in either column — the company when there is one, always with the person behind it. */
function RecipientRow({
  row,
  reason,
}: {
  row: MailoutPreviewRow;
  reason?: string | null;
}) {
  return (
    <div className="border-b border-divider px-3 py-2 last:border-0">
      <p className="truncate text-[13px] text-ink">
        {row.companyName ?? row.clientName}
        {row.companyName && <span className="text-muted"> · {row.clientName}</span>}
      </p>
      <p className="truncate text-[12px] text-muted">{reason ?? row.email ?? "no address"}</p>
    </div>
  );
}

/**
 * One line in the picker: a client, or — indented — one of their companies.
 *
 * The same row for both on purpose. A company is a real addressee with its own inbox, not a
 * property of the client, and the moment it is drawn as a lesser thing somebody starts wondering
 * whether ticking it really sends anything.
 */
function Addressee({
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
        <span className="block truncate text-[12px] text-muted">
          {email ?? "no email address"}
        </span>
      </span>
    </label>
  );
}

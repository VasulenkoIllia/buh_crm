import { useEffect, useRef, useState } from "react";
import type { EmailTemplate } from "@shared/schema/mailouts";
import { CLIENT_VARIABLES, FIRM_VARIABLES, renderMailText, sampleVars } from "@shared/mailouts";
import { Button } from "@/shared/ui/button";
import { FormField, Input, Select, Textarea } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { Segmented } from "@/shared/ui/segmented";
import { LetterPreviewModal } from "./letter-preview-modal";
import { useCreateTemplate, useSenderOptions, useUpdateTemplate } from "./mailouts.api";

/**
 * The template editor.
 *
 * Two things it deliberately does NOT let you edit: the letter's frame (logo, signature, footer)
 * and its recipients. The frame is identical on every letter by design — that was the firm's
 * requirement and it is also what makes the mail recognisable to spam filters. Recipients are
 * chosen at send time, on the composer.
 */
export function TemplateModal({
  open,
  template,
  onClose,
}: {
  open: boolean;
  template: EmailTemplate | null;
  onClose: () => void;
}) {
  const create = useCreateTemplate();
  const update = useUpdateTemplate();
  const senders = useSenderOptions();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [lastFocused, setLastFocused] = useState<"subject" | "heading" | "body">("body");

  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [heading, setHeading] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<"commercial" | "transactional">("commercial");
  const [senderAccountId, setSenderAccountId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [showingLetter, setShowingLetter] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(template?.name ?? "");
    setSubject(template?.subject ?? "");
    setHeading(template?.heading ?? "");
    setBody(template?.body ?? "");
    setKind(template?.kind ?? "commercial");
    setSenderAccountId(template?.senderAccountId ?? "");
    setError(null);
    setFieldErrors({});
    setShowingLetter(false);
  }, [open, template]);

  const setters = { subject: setSubject, heading: setHeading, body: setBody };
  const values = { subject, heading, body };

  /** Insert at the caret of whichever field was last touched — not always at the end. */
  function insertVariable(key: string) {
    const token = `{{${key}}}`;
    if (lastFocused === "body" && bodyRef.current) {
      const el = bodyRef.current;
      const start = el.selectionStart ?? body.length;
      const end = el.selectionEnd ?? body.length;
      const next = body.slice(0, start) + token + body.slice(end);
      setBody(next);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(start + token.length, start + token.length);
      });
      return;
    }
    setters[lastFocused](values[lastFocused] + token);
  }

  // The same renderer the server uses, against sample values — so what is previewed here is
  // exactly the substitution that will happen at send time.
  const vars = sampleVars();
  const previewSubject = renderMailText(subject, vars).text;
  const previewHeading = renderMailText(heading || subject, vars).text;
  const previewBody = renderMailText(body, vars);

  async function submit() {
    setError(null);
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = "Required";
    if (!subject.trim()) errors.subject = "Required";
    if (!body.trim()) errors.body = "Required";
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;

    const input = {
      name: name.trim(),
      subject: subject.trim(),
      heading: heading.trim() || null,
      body: body.trim(),
      kind,
      senderAccountId: senderAccountId || null,
    };
    try {
      if (template) await update.mutateAsync({ id: template.id, input });
      else await create.mutateAsync(input);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the template");
    }
  }

  const busy = create.isPending || update.isPending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={template ? "Edit template" : "New template"}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      }
    >
      {error && (
        <p className="mb-3 rounded-(--radius-field) bg-danger/10 px-3 py-2 text-[13px] text-danger-text">
          {error}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-[1fr_300px]">
        <div className="space-y-3">
          <FormField label="Template name" error={fieldErrors.name}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Quarterly filing reminder"
              error={!!fieldErrors.name}
            />
          </FormField>

          <FormField label="Subject" error={fieldErrors.subject}>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              onFocus={() => setLastFocused("subject")}
              placeholder="Your {{company}} filing is ready"
              error={!!fieldErrors.subject}
            />
          </FormField>

          <FormField label="Heading (optional — the subject is used when empty)">
            <Input
              value={heading}
              onChange={(e) => setHeading(e.target.value)}
              onFocus={() => setLastFocused("heading")}
              placeholder="Hello {{first_name}}"
            />
          </FormField>

          <FormField label="Body" error={fieldErrors.body}>
            <Textarea
              ref={bodyRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onFocus={() => setLastFocused("body")}
              className="h-[220px]"
              placeholder={"Dear {{first_name}},\n\nYour documents are ready for review."}
            />
          </FormField>

          <FormField label="Usually sent from">
            <Select
              value={senderAccountId}
              onChange={(e) => setSenderAccountId(e.target.value)}
            >
              <option value="">The default mailbox</option>
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
          <p className="-mt-1 text-[12px] leading-relaxed text-muted">
            A send can still override this. Letters about money usually come from a different
            address than news does.
          </p>

          <div>
            <p className="mb-1.5 text-[12px] font-medium text-ink-700">Kind</p>
            <Segmented
              value={kind}
              onChange={(v) => setKind(v as "commercial" | "transactional")}
              options={[
                { value: "commercial", label: "Commercial" },
                { value: "transactional", label: "Transactional" },
              ]}
            />
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
              {kind === "commercial"
                ? "News and offers. Carries an unsubscribe link and the firm's postal address, and is not sent to clients who unsubscribed — as US law requires."
                : "About the client's own account: an invoice, a document request. No unsubscribe link, and it still reaches clients who unsubscribed from news."}
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <p className="mb-1.5 text-[12px] font-medium text-ink-700">Insert a variable</p>
            <p className="mb-2 text-[12px] text-muted">
              Filled from the client card. A client missing one is skipped, never sent a letter
              with a gap in it.
            </p>
            <div className="flex flex-wrap gap-1">
              {CLIENT_VARIABLES.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => insertVariable(v.key)}
                  title={v.label}
                  className="rounded-(--radius-chip) border border-border bg-surface px-2 py-1 font-mono text-[11px] text-ink hover:bg-divider"
                >
                  {v.key}
                </button>
              ))}
              {FIRM_VARIABLES.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => insertVariable(v.key)}
                  title={`${v.label} (from Settings)`}
                  className="rounded-(--radius-chip) border border-dashed border-border bg-surface px-2 py-1 font-mono text-[12px] text-muted hover:bg-divider"
                >
                  {v.key}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-(--radius-field) border border-border bg-surface p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-[12px] font-medium uppercase tracking-wide text-muted">
                Preview — sample client
              </p>
              {/* This panel is instant and updates as you type; the real letter costs a round trip
                  and opens full size, where the kind switch and the highlight live. */}
              <button
                type="button"
                onClick={() => setShowingLetter(true)}
                disabled={!subject.trim() || !body.trim()}
                className="text-[11px] text-primary-link hover:underline disabled:opacity-40 disabled:hover:no-underline"
              >
                See the full letter
              </button>
            </div>
            <p className="mb-1 text-[12px] text-muted">Subject</p>
            <p className="mb-3 text-[13px] font-medium text-ink">{previewSubject || "—"}</p>
            <p className="mb-2 text-[15px] font-semibold text-ink">{previewHeading || "—"}</p>
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-700">
              {previewBody.text || "—"}
            </p>
            {previewBody.unknown.length > 0 && (
              <p className="mt-3 rounded-(--radius-field) bg-danger/10 px-2 py-1.5 text-[11px] text-danger-text">
                Not a real variable: {previewBody.unknown.map((u) => `{{${u}}}`).join(", ")} —
                it will appear in the letter exactly as written.
              </p>
            )}
          </div>
        </div>
      </div>
      <LetterPreviewModal
        open={showingLetter}
        onClose={() => setShowingLetter(false)}
        subject={subject}
        heading={heading}
        body={body}
        kind={kind}
        onKindChange={setKind}
      />
    </Modal>
  );
}

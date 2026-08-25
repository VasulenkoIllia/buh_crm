import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { LetterPreview } from "@shared/schema/mailouts";
import type { MailoutKind } from "@shared/schema/enums";
import { MAIL_VARIABLES } from "@shared/mailouts";
import { Modal } from "@/shared/ui/modal";
import { Segmented } from "@/shared/ui/segmented";
import { LetterFrame } from "./letter-frame";
import { usePreviewLetter } from "./mailouts.api";

type View = "letter" | "changes";

/**
 * The letter, full size, with the two questions the editor cannot answer beside it:
 *
 *  - **which kind is this?** The switch is bound to the template's own `kind`, not a preview-only
 *    copy, so flipping it here changes the template. One value, editable from two places — the
 *    alternative is a preview that can quietly disagree with what will be saved.
 *  - **what actually gets replaced?** A second view paints every substituted value, so the firm can
 *    see which words come from a client card and which are fixed. A `Segmented` rather than a
 *    stray checkbox: it is a *view* of the same letter, which is what this control already means
 *    everywhere else in the app.
 */
export function LetterPreviewModal({
  open,
  onClose,
  subject,
  heading,
  body,
  kind,
  onKindChange,
}: {
  open: boolean;
  onClose: () => void;
  subject: string;
  heading: string;
  body: string;
  kind: MailoutKind;
  onKindChange: (kind: MailoutKind) => void;
}) {
  const preview = usePreviewLetter();
  const [result, setResult] = useState<LetterPreview | null>(null);
  const [view, setView] = useState<View>("letter");
  const [error, setError] = useState<string | null>(null);

  // Re-render whenever the letter or its kind changes — the kind decides whether the legal footer
  // is there at all, which is most of what there is to compare between the two.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    preview
      .mutateAsync({
        subject: subject.trim(),
        heading: heading.trim() || null,
        body: body.trim(),
        kind,
      })
      .then((r) => !cancelled && setResult(r))
      .catch(
        (e) => !cancelled && setError(e instanceof Error ? e.message : "Could not render"),
      );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, subject, heading, body, kind]);

  const used = MAIL_VARIABLES.filter((v) => result?.variablesUsed.includes(v.key));

  return (
    <Modal open={open} onClose={onClose} size="xl" title="The letter">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="w-[260px]">
          <Segmented
            value={kind}
            onChange={(v) => onKindChange(v as MailoutKind)}
            options={[
              { value: "commercial", label: "Commercial" },
              { value: "transactional", label: "Transactional" },
            ]}
          />
        </div>
        <div className="w-[240px]">
          <Segmented
            value={view}
            onChange={(v) => setView(v as View)}
            options={[
              { value: "letter", label: "Letter" },
              { value: "changes", label: "What changes" },
            ]}
          />
        </div>
      </div>

      <p className="mb-3 text-[12px] leading-relaxed text-muted">
        {kind === "commercial"
          ? "Commercial: closes with the firm's postal address and an unsubscribe link, and is not sent to clients who unsubscribed."
          : "Transactional: no unsubscribe link and no postal address, and it still reaches clients who unsubscribed from news."}
      </p>

      {error && (
        <p className="mb-3 rounded-(--radius-field) bg-danger/10 px-3 py-2 text-[13px] text-danger-text">
          {error}
        </p>
      )}

      {result?.blockedReason && (
        <p className="mb-3 flex gap-2 rounded-(--radius-field) bg-danger/10 px-3 py-2 text-[12px] text-danger-text">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {result.blockedReason}
        </p>
      )}

      {result && result.unknownVariables.length > 0 && (
        <p className="mb-3 rounded-(--radius-field) bg-danger/10 px-3 py-2 text-[12px] text-danger-text">
          Not real variables: {result.unknownVariables.map((u) => `{{${u}}}`).join(", ")} — they
          will appear in the letter exactly as written.
        </p>
      )}

      {view === "changes" && (
        <div className="mb-3 rounded-(--radius-field) border border-border bg-surface px-3 py-2.5">
          <p className="text-[12px] text-muted">
            <span className="mr-1.5 inline-block rounded-(--radius-chip) bg-[#fff3bf] px-1.5 py-0.5 text-[12px] text-ink">
              highlighted
            </span>
            comes from the client card and differs per recipient. Everything else is identical
            in every letter.
          </p>
          {used.length > 0 && (
            <p className="mt-2 flex flex-wrap gap-1">
              {used.map((v) => (
                <span
                  key={v.key}
                  className="rounded-(--radius-chip) border border-border bg-white px-1.5 py-0.5 font-mono text-[10px] text-ink-700"
                >
                  {v.key}
                </span>
              ))}
            </p>
          )}
        </div>
      )}

      {result ? (
        <LetterFrame
          html={view === "changes" ? result.highlightedHtml : result.html}
          min={520}
        />
      ) : (
        <p className="text-[13px] text-muted">Rendering…</p>
      )}

      <p className="mt-2 text-[12px] text-muted-400">
        Sample values. The frame — logo, signature, contact buttons, footer — is the same on
        every letter and is not editable per template.
      </p>
    </Modal>
  );
}

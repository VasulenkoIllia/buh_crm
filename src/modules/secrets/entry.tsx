import { useEffect, useState } from "react";
import { Copy, Eye, EyeOff } from "lucide-react";
import { TEMPLATE_COPY, type SecretRow } from "@shared/schema/secrets";
import { ApiError } from "@/shared/lib/api";
import { fmtDateTime } from "@/shared/lib/format";
import { Button } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";
import { CopyLink } from "@/shared/ui/copy-link";
import { Modal } from "@/shared/ui/modal";
import { useToast } from "@/shared/ui/toast";
import type { UiPlace } from "./places";
import { AttachmentsList } from "./attachments";
import { revealSecret, useHistory } from "./secrets.api";
import { TemplateIcon, labelOfField, summaryOf } from "./template-bits";
import { UnlockModal, useVaultWindow } from "./unlock";

/** What each journal action means, in the words somebody reading it would use. */
export const ACTION: Record<
  string,
  { text: string; tone: "gray" | "blue" | "amber" | "teal" }
> = {
  created: { text: "Added", tone: "teal" },
  updated: { text: "Changed", tone: "gray" },
  deleted: { text: "Deleted", tone: "gray" },
  restored: { text: "Restored", tone: "teal" },
  file_added: { text: "File added", tone: "teal" },
  file_opened: { text: "File opened", tone: "blue" },
  file_removed: { text: "File removed", tone: "gray" },
  moved: { text: "Moved", tone: "gray" },
  revealed: { text: "Viewed", tone: "blue" },
  purged: { text: "Removed for good", tone: "gray" },
  unlock_failed: { text: "Wrong password", tone: "amber" },
};

/**
 * **One entry, in a window over the list** (secrets.md §15, decision 16). Its open fields as text,
 * its secret fields behind the password step, and its own History.
 *
 * A reveal opens ALL of an entry's secret fields at once and counts as one look in the journal
 * (§6), so the values arrive together and the per-field buttons after that only hide and show what
 * is already on this screen. The plaintext lives in this component's state and nowhere else: never
 * in the query cache, where it would survive navigation and show up in devtools.
 */
/** What the window needs of a secret: a search hit carries all of it, and so does a list row. */
export type Openable = Pick<
  SecretRow,
  "id" | "template" | "label" | "description" | "fields" | "hasValue" | "files"
>;

export function SecretWindow({
  place,
  secret,
  onClose,
  footer,
}: {
  place: UiPlace;
  secret: Openable;
  onClose: () => void;
  /** Edit, Move and Delete, which the screen around this window owns */
  footer?: (context: { revealed: Record<string, string> | null }) => React.ReactNode;
}) {
  const { unlocked } = useVaultWindow();
  const toast = useToast();
  const history = useHistory(secret.id);
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  // the window's plaintext dies with the window, and with the vault's own five minutes
  useEffect(() => () => setValues(null), []);
  useEffect(() => {
    if (!unlocked) setValues(null);
  }, [unlocked]);

  /** `afterUnlock`: the password was just accepted, and the grant has not refetched yet. */
  const reveal = async (afterUnlock = false) => {
    if (!unlocked && !afterUnlock) return setAsking(true);
    setBusy(true);
    setError(null);
    try {
      const res = await revealSecret(place, secret.id);
      setValues(res.secret);
      setHidden(new Set());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not show the values");
    } finally {
      setBusy(false);
    }
  };

  const copy = (field: string, value: string) => {
    void navigator.clipboard?.writeText(value).then(
      () => toast({ text: `${labelOfField(field)} copied` }),
      () => toast({ text: "The browser would not let the CRM copy it" }),
    );
  };

  const open = Object.entries(secret.fields);
  const sub = [TEMPLATE_COPY[secret.template].label, summaryOf(secret)]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <Modal
        title={secret.label}
        open
        size="lg"
        onClose={onClose}
        // the link names no secret: the card it draws in a chat says only where it lives and what
        // kind it is (secrets.md §22)
        actions={
          <CopyLink href={`/secrets?secret=${secret.id}`} label="Copy link to this entry" />
        }
        footer={footer?.({ revealed: values })}
      >
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <TemplateIcon template={secret.template} big />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-muted">{sub}</p>
              {/* a reference only when nothing at all is kept here, files included (§21) */}
              {!secret.hasValue && secret.files.length === 0 && (
                <Chip tone="gray" size="sm" className="mt-1">
                  reference only
                </Chip>
              )}
            </div>
          </div>

          {secret.description && (
            <p className="whitespace-pre-wrap text-[13px] text-ink-700">{secret.description}</p>
          )}

          {open.length > 0 && (
            <dl className="grid grid-cols-[150px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
              {open.map(([field, value]) => (
                <div key={field} className="contents">
                  <dt className="text-muted">{labelOfField(field)}</dt>
                  <dd className="m-0 overflow-wrap-anywhere text-ink">{value}</dd>
                </div>
              ))}
            </dl>
          )}

          {secret.hasValue ? (
            <div className="rounded-(--radius-card) border border-[#e0d3b8] bg-[#fdf8ee] p-3">
              {values ? (
                <div className="space-y-1.5">
                  {Object.entries(values).map(([field, value]) => {
                    const masked = hidden.has(field);
                    return (
                      <div
                        key={field}
                        className="grid grid-cols-[150px_minmax(0,1fr)_auto] items-center gap-3 border-b border-dashed border-[#e0d3b8] py-1.5 last:border-0"
                      >
                        <span className="text-[13px] text-muted">{labelOfField(field)}</span>
                        <span className="whitespace-pre-wrap break-all font-mono text-[12.5px] text-ink">
                          {masked ? "••••••••••" : value}
                        </span>
                        <span className="flex gap-1">
                          <button
                            type="button"
                            className="rounded-(--radius-btn-sm) px-2 py-1 text-[12px] text-primary-link hover:bg-primary-soft"
                            onClick={() =>
                              setHidden((was) => {
                                const next = new Set(was);
                                if (masked) next.delete(field);
                                else next.add(field);
                                return next;
                              })
                            }
                          >
                            {masked ? "Show" : "Hide"}
                          </button>
                          <button
                            type="button"
                            className="rounded-(--radius-btn-sm) px-2 py-1 text-[12px] text-primary-link hover:bg-primary-soft"
                            onClick={() => copy(field, value)}
                          >
                            <Copy size={12} className="mr-1 inline" />
                            Copy
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="flex items-center gap-3 text-[13px]">
                  <EyeOff size={15} className="text-muted" />
                  <span className="text-ink-700">The values are hidden.</span>
                  <span className="flex-1" />
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => void reveal()}
                  >
                    <Eye size={14} />
                    {busy ? "Opening…" : "Show values"}
                  </Button>
                </div>
              )}
              {error && <p className="mt-2 text-[12px] text-danger-text">{error}</p>}
            </div>
          ) : secret.files.length === 0 ? (
            <p className="rounded-(--radius-card) bg-divider px-3 py-2 text-[12.5px] text-ink-700">
              Nothing is stored here. The description says where it lives.
            </p>
          ) : null}

          {secret.files.length > 0 && <AttachmentsList files={secret.files} />}

          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-[.04em] text-muted-400">
              History
            </p>
            {history.isLoading && <p className="text-[12.5px] text-muted">Loading…</p>}
            <div className="text-[12.5px]">
              {history.data?.slice(0, 8).map((row) => {
                const act = ACTION[row.action] ?? { text: row.action, tone: "gray" as const };
                return (
                  <div
                    key={row.id}
                    className="flex items-center gap-2 border-b border-divider py-1.5 last:border-0"
                  >
                    <Chip tone={act.tone} size="sm">
                      {act.text}
                    </Chip>
                    <span className="text-ink-700">{row.byName}</span>
                    <span className="ml-auto text-muted">{fmtDateTime(row.createdAt)}</span>
                  </div>
                );
              })}
              {history.data?.length === 0 && (
                <p className="text-[12.5px] text-muted">Nothing recorded yet.</p>
              )}
            </div>
          </div>
        </div>
      </Modal>
      {asking && (
        <UnlockModal onClose={() => setAsking(false)} onDone={() => void reveal(true)} />
      )}
    </>
  );
}

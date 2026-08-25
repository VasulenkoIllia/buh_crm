import { useState } from "react";
import {
  AlertTriangle,
  Check,
  Info,
  Pencil,
  Plug,
  Plus,
  Receipt,
  Send,
  Star,
  Trash2,
} from "lucide-react";
import type { MailSenderAccountDto, SenderTestResult } from "@shared/schema/mailouts";
import { useAuth } from "@/app/auth";
import { cn } from "@/shared/lib/cn";
import { Button, IconButton } from "@/shared/ui/button";
import { SenderAccountModal } from "./sender-account-modal";
import {
  useDeleteSender,
  useRemoveMailLogo,
  useSetMailLogo,
  useMailSenders,
  useMakeInvoiceSender,
  useMakeSenderDefault,
  useTestSender,
  useUpdateFirmMail,
} from "./mailouts.api";

/**
 * Where the letters come from.
 *
 * A list, not a form. The page used to stack three warning banners, a status panel and nine fields
 * for a single mailbox; the firm sends from several, and the question it should answer at a glance
 * is "which mailboxes do we have, and is anything wrong with them". Editing happens in a modal,
 * where nine fields are the point rather than the noise.
 */
export function SenderSettings() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { data, isLoading } = useMailSenders();
  const [editing, setEditing] = useState<MailSenderAccountDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isLoading || !data) return <p className="text-[13px] text-muted">Loading…</p>;

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-(--radius-field) bg-danger/10 px-3 py-2 text-[13px] text-danger-text">
          {error}
        </p>
      )}

      <FirmMailBlock postalAddress={data.postalAddress} logo={data.logo} isAdmin={isAdmin} />

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[15px] font-semibold">Mailboxes</h2>
          <p className="text-[12px] text-muted-400">
            One is the default for letters; one is where invoices will go from when Payments
            starts emailing them.
          </p>
        </div>
        {isAdmin && (
          <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
            <Plus size={14} /> Add a mailbox
          </Button>
        )}
      </div>

      {data.accounts.length === 0 ? (
        <div className="rounded-(--radius-panel) border border-dashed border-[#cfd4db] bg-surface p-12 text-center">
          <div className="text-[15px] font-semibold">No mailboxes yet</div>
          <p className="mt-1 text-[13px] text-muted">Nothing can be sent until there is one.</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {data.accounts.map((a) => (
            <AccountCard
              key={a.id}
              account={a}
              isAdmin={isAdmin}
              onEdit={() => setEditing(a)}
              onError={setError}
            />
          ))}
        </div>
      )}

      {!isAdmin && <p className="text-[12px] text-faint">Only an admin can change these.</p>}

      <SenderAccountModal
        open={creating}
        account={null}
        server={data.server}
        onClose={() => setCreating(false)}
      />
      <SenderAccountModal
        open={!!editing}
        account={editing}
        server={data.server}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}

// ── one mailbox ──────────────────────────────────────────────────────────────

function AccountCard({
  account,
  isAdmin,
  onEdit,
  onError,
}: {
  account: MailSenderAccountDto;
  isAdmin: boolean;
  onEdit: () => void;
  onError: (message: string | null) => void;
}) {
  const makeDefault = useMakeSenderDefault();
  const makeInvoice = useMakeInvoiceSender();
  const remove = useDeleteSender();
  const test = useTestSender();
  const [result, setResult] = useState<SenderTestResult | null>(null);

  const errors = account.checks.filter((c) => c.level === "error");
  const warnings = account.checks.filter((c) => c.level === "warning");

  async function run(sendTestLetter: boolean) {
    onError(null);
    setResult(null);
    try {
      setResult(await test.mutateAsync({ id: account.id, sendTestLetter }));
    } catch (e) {
      setResult({
        ok: false,
        step: "connect",
        message: e instanceof Error ? e.message : "The test could not be run",
        sentTo: null,
      });
    }
  }

  const act = async (fn: () => Promise<unknown>) => {
    onError(null);
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not do that");
    }
  };

  return (
    <div
      className={cn(
        "rounded-(--radius-panel) border bg-surface p-4 shadow-(--shadow-card)",
        account.active ? "border-border" : "border-border opacity-70",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-medium">{account.name}</span>
            {account.isDefault && (
              <span className="inline-flex items-center gap-1 rounded-(--radius-chip) bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary-link">
                <Star size={10} /> default
              </span>
            )}
            {account.isInvoiceSender && (
              <span className="inline-flex items-center gap-1 rounded-(--radius-chip) bg-[#eef0f3] px-1.5 py-0.5 text-[10px] font-medium text-muted">
                <Receipt size={10} /> invoices
              </span>
            )}
            {!account.active && (
              <span className="rounded-(--radius-chip) bg-[#eef0f3] px-1.5 py-0.5 text-[10px] text-muted">
                inactive
              </span>
            )}
            {errors.length > 0 && (
              <span className="inline-flex items-center gap-1 rounded-(--radius-chip) bg-danger/12 px-1.5 py-0.5 text-[10px] font-medium text-danger-text">
                <AlertTriangle size={10} /> {errors.length}
              </span>
            )}
          </div>
          <p className="mt-1 truncate font-mono text-[12px] text-ink-700">
            {account.effectiveFrom}
          </p>
          <p className="truncate font-mono text-[12px] text-muted">
            {account.effectiveAccount}
          </p>
        </div>

        {/* Six text buttons stood here — "Edit · Make default · Use for invoices · Test · Send me
            a letter · Delete" — repeated on every mailbox, which is exactly the wall of repeated
            words IconButton was introduced to end. The controls no longer appear and disappear
            either: a toggle that is already on is shown ON and disabled with the reason, because a
            button that vanishes when you use it is harder to learn than one that stays. */}
        {isAdmin && (
          <div className="flex shrink-0 items-center gap-1">
            <IconButton label="Edit this mailbox" onClick={onEdit}>
              <Pencil size={15} />
            </IconButton>
            <IconButton
              label={
                account.isDefault
                  ? "The default mailbox — make another one the default to move it"
                  : "Make this the default mailbox"
              }
              disabled={makeDefault.isPending || account.isDefault || !account.active}
              className={cn(account.isDefault && "text-primary-link hover:text-primary-link")}
              onClick={() => act(() => makeDefault.mutateAsync(account.id))}
            >
              <Star size={15} fill={account.isDefault ? "currentColor" : "none"} />
            </IconButton>
            <IconButton
              label={
                account.isInvoiceSender
                  ? "Invoices go from here"
                  : "Send invoices from this mailbox"
              }
              disabled={makeInvoice.isPending || account.isInvoiceSender || !account.active}
              className={cn(
                account.isInvoiceSender && "text-primary-link hover:text-primary-link",
              )}
              onClick={() => act(() => makeInvoice.mutateAsync(account.id))}
            >
              <Receipt size={15} />
            </IconButton>
            <IconButton
              label="Test the connection — connects and authenticates, sends nothing"
              disabled={test.isPending}
              onClick={() => run(false)}
            >
              <Plug size={15} />
            </IconButton>
            <IconButton
              label="Send a real test letter to your own address"
              disabled={test.isPending}
              onClick={() => run(true)}
            >
              <Send size={15} />
            </IconButton>
            <IconButton
              label={
                account.isDefault
                  ? "The default mailbox cannot be deleted — move the default first"
                  : "Delete this mailbox"
              }
              disabled={remove.isPending || account.isDefault}
              className="hover:text-danger"
              onClick={() => act(() => remove.mutateAsync(account.id))}
            >
              <Trash2 size={15} />
            </IconButton>
          </div>
        )}
      </div>

      {/* Errors always; warnings folded away, because "borrows the server account" on three
          mailboxes is three copies of something the firm read once. */}
      {errors.map((c, i) => (
        <p
          key={i}
          className="mt-2 flex gap-2 rounded-(--radius-field) bg-danger/10 px-2.5 py-2 text-[12px] leading-relaxed text-danger-text"
        >
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {c.message}
        </p>
      ))}
      {warnings.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[12px] text-muted hover:text-ink">
            {warnings.length} thing{warnings.length === 1 ? "" : "s"} worth knowing
          </summary>
          {warnings.map((c, i) => (
            <p key={i} className="mt-1.5 pl-1 text-[12px] leading-relaxed text-faint">
              {c.message}
            </p>
          ))}
        </details>
      )}

      {test.isPending && <p className="mt-2 text-[12px] text-muted">Connecting…</p>}
      {result && !test.isPending && (
        <p
          className={cn(
            "mt-2 flex gap-2 rounded-(--radius-field) px-2.5 py-2 text-[12px] leading-relaxed",
            result.ok ? "bg-success/12 text-success" : "bg-danger/10 text-danger-text",
          )}
        >
          {result.ok ? (
            <Check size={13} className="mt-0.5 shrink-0" />
          ) : (
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          )}
          {result.message}
        </p>
      )}
    </div>
  );
}

// ── the firm's own bits ──────────────────────────────────────────────────────

/**
 * The postal address and the logo belong to the FIRM, not to any one mailbox — one legal address,
 * one mark. Kept above the list, and small, because they are set once and then forgotten.
 */
function FirmMailBlock({
  postalAddress,
  logo,
  isAdmin,
}: {
  postalAddress: string | null;
  logo: { id: string; name: string } | null;
  isAdmin: boolean;
}) {
  const update = useUpdateFirmMail();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(postalAddress ?? "");

  async function save() {
    await update.mutateAsync({ postalAddress: value });
    setEditing(false);
  }

  if (!postalAddress && !editing) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-(--radius-field) bg-danger/10 px-3 py-2.5">
        <p className="flex gap-2 text-[12px] leading-relaxed text-danger-text">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>
            <strong>Commercial mailouts are blocked.</strong> US law requires the firm's postal
            address in every commercial email. Invoices are exempt and unaffected.
          </span>
        </p>
        {isAdmin && (
          <Button size="sm" onClick={() => setEditing(true)}>
            Add it
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-(--radius-panel) border border-border bg-surface p-4 shadow-(--shadow-card)">
      {editing ? (
        <div className="space-y-2">
          <p className="text-[12px] font-medium text-ink-700">
            Firm postal address — required by law in commercial mail
          </p>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-[54px] w-full resize-none rounded-(--radius-field) border border-border px-3 py-2 text-[13px] outline-none focus:border-primary"
            placeholder="1200 Main St, Suite 4, Charlotte, NC 28202"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={update.isPending}>
              {update.isPending ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[12px] text-muted">
              Firm postal address · in every commercial letter
            </p>
            <p className="truncate text-[13px] text-ink">{postalAddress}</p>
          </div>
          {isAdmin && (
            <IconButton
              label="Change the firm's postal address"
              onClick={() => setEditing(true)}
            >
              <Pencil size={15} />
            </IconButton>
          )}
        </div>
      )}

      <LetterheadRow logo={logo} isAdmin={isAdmin} />
    </div>
  );
}

/**
 * The mark that goes in letters — uploaded here, not taken from Settings.
 *
 * The sidebar logo and the letterhead have different jobs: the sidebar is small and sits on a dark
 * panel, this one is 168px wide on white. Sharing one file would mean restyling the app silently
 * restyles what clients receive.
 */
function LetterheadRow({
  logo,
  isAdmin,
}: {
  logo: { id: string; name: string } | null;
  isAdmin: boolean;
}) {
  const upload = useSetMailLogo();
  const remove = useRemoveMailLogo();
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      await upload.mutateAsync(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not upload");
    }
  }

  return (
    <div className="mt-3 border-t border-divider pt-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {logo ? (
            <img
              src="/api/mailouts/settings/mail-logo"
              alt="Letterhead"
              className="h-8 w-auto max-w-[160px] object-contain"
            />
          ) : (
            <span className="flex items-center gap-1.5 text-[12px] text-faint">
              <Info size={13} /> No letterhead — letters set the firm name in type
            </span>
          )}
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            <label className="cursor-pointer text-[12px] text-primary-link hover:underline">
              {upload.isPending ? "Uploading…" : logo ? "Replace" : "Upload a letterhead"}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={(e) => pick(e.target.files?.[0])}
              />
            </label>
            {logo && (
              <IconButton
                label="Remove the letterhead — letters fall back to the firm name in type"
                disabled={remove.isPending}
                className="hover:text-danger"
                onClick={() => {
                  setError(null);
                  remove
                    .mutateAsync(undefined as never)
                    .catch((e) =>
                      setError(
                        e instanceof Error ? e.message : "Could not remove the letterhead",
                      ),
                    );
                }}
              >
                <Trash2 size={15} />
              </IconButton>
            )}
          </div>
        )}
      </div>
      <p className="mt-1.5 text-[12px] text-muted">
        PNG, JPEG, WebP or GIF — not SVG, which mail clients do not render. Drawn 168px wide, so
        a tight crop of the lockup reads best.
      </p>
      {error && <p className="mt-1.5 text-[11px] text-danger-text">{error}</p>}
    </div>
  );
}

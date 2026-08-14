import { useEffect, useRef, useState } from "react";
import { Eye, KeyRound, Pencil, Trash2 } from "lucide-react";
import type { ClientSecret } from "@shared/schema/client";
import { ApiError } from "@/shared/lib/api";
import { cn } from "@/shared/lib/cn";
import { fmtDateTime } from "@/shared/lib/format";
import { Button, IconButton } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";
import { FormField, Input, Textarea } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import {
  fetchSecretAudit,
  type SecretAuditPage,
  revealSecret,
  useClientSecrets,
  useDeleteSecret,
  useSaveSecret,
  useSecretGrant,
  useUnlockSecrets,
} from "./clients.api";

/**
 * The client's Secrets tab — tax-portal logins, client-bank credentials, КЕП passwords.
 *
 * Everyone who can open the client reads the LABEL and DESCRIPTION: knowing that a tax-portal
 * login exists, and what it is for, is ordinary working knowledge. The VALUE needs the viewer's
 * OWN password and a five-minute window that the SERVER counts.
 *
 * Admin-only until 2026-08-14. The role went, the password did not: everyone who works a client's
 * file needs its portal login, and a rule half the team has to route around gets routed around by
 * keeping the password somewhere worse. What actually guards the value is the password prompt and
 * the log with a name in it, and both are still here.
 *
 * The plaintext lives in component state and nowhere else — never in the react-query cache, where
 * it would survive navigation and show up in devtools — and it is wiped when the window closes,
 * when the row is collapsed, and when this component unmounts.
 */
export function SecretsTab({ clientId }: { clientId: string }) {
  const { data: secrets, isLoading, error } = useClientSecrets(clientId);
  const { data: grant } = useSecretGrant(clientId);
  const remove = useDeleteSecret(clientId);

  const [editing, setEditing] = useState<ClientSecret | "new" | null>(null);
  const [unlockFor, setUnlockFor] = useState<string | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const unlocked = !!grant?.expiresAt && new Date(grant.expiresAt).getTime() > Date.now();

  return (
    <div className="rounded-(--radius-panel) border border-border bg-surface p-5">
      <div className="mb-1 flex items-center justify-between">
        {/* The rule is worth stating once, not in a paragraph above every visit — it lives on the
            heading, where someone who wants it will look (user, 2026-08-03). */}
        <h2
          className="flex items-center gap-2 text-[15px] font-semibold"
          title="Stored encrypted. Reading or deleting a value costs your own password and lasts five minutes. Every look is logged, with your name on it."
        >
          <KeyRound size={16} className="text-muted" />
          Secrets
          {unlocked && grant?.expiresAt && <Countdown until={grant.expiresAt} />}
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="text-[12px] text-primary-link hover:underline"
            onClick={() => setAuditOpen(true)}
          >
            Access log
          </button>
          <Button variant="secondary" size="sm" onClick={() => setEditing("new")}>
            + Add secret
          </Button>
        </div>
      </div>

      {isLoading && <p className="text-[13px] text-muted">Loading…</p>}
      {error && <p className="text-[13px] text-danger-text">Failed to load.</p>}
      {secrets?.length === 0 && (
        <p className="text-[13px] text-muted">
          No secrets yet — add the client&apos;s portal or bank login.
        </p>
      )}
      {failure && <p className="mb-2 text-[12px] text-danger-text">{failure}</p>}

      <div className="space-y-1.5">
        {secrets?.map((s) => (
          <SecretRow
            key={s.id}
            clientId={clientId}
            secret={s}
            unlocked={unlocked}
            onNeedUnlock={() => setUnlockFor(s.id)}
            // the editor now shows the stored value, so it costs the same password as reading
            onEdit={() => (unlocked || !s.hasValue ? setEditing(s) : setUnlockFor(s.id))}
            onDelete={() => {
              // same gate as reading: deleting a client's portal login is irreversible
              if (!unlocked) return setUnlockFor(s.id);
              if (window.confirm(`Delete “${s.label}”? The access log is kept.`))
                remove.mutateAsync(s.id).catch((e) => setFailure((e as Error).message));
            }}
          />
        ))}
      </div>

      {editing && (
        <SecretForm
          clientId={clientId}
          secret={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {unlockFor && (
        <UnlockModal clientId={clientId} onClose={() => setUnlockFor(null)} />
      )}
      {auditOpen && <AuditModal clientId={clientId} onClose={() => setAuditOpen(false)} />}
    </div>
  );
}

/** Minutes:seconds left on the window, so nobody is surprised when a value blanks. */
function Countdown({ until }: { until: string }) {
  const [left, setLeft] = useState(() => Math.max(0, new Date(until).getTime() - Date.now()));
  useEffect(() => {
    const t = setInterval(
      () => setLeft(Math.max(0, new Date(until).getTime() - Date.now())),
      1000,
    );
    return () => clearInterval(t);
  }, [until]);
  if (left <= 0) return null;
  const s = Math.ceil(left / 1000);
  return (
    <Chip tone="amber" size="sm">
      unlocked {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </Chip>
  );
}

function SecretRow({
  clientId,
  secret,
  unlocked,
  onNeedUnlock,
  onEdit,
  onDelete,
}: {
  clientId: string;
  secret: ClientSecret;
  unlocked: boolean;
  onNeedUnlock: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // the plaintext must not outlive this row on screen, whatever ends it
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      setValue(null);
    },
    [],
  );

  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setValue(null);
  };

  const reveal = async () => {
    setError(null);
    if (!unlocked) return onNeedUnlock();
    setBusy(true);
    try {
      const res = await revealSecret(clientId, secret.id);
      setValue(res.value);
      const ms = Math.max(0, new Date(res.expiresAt).getTime() - Date.now());
      timer.current = setTimeout(hide, ms); // the server's window, not ours
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not reveal");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-[8px] border border-border bg-surface px-3 py-2 text-[13px]">
      <div className="flex items-center gap-2">
        <span className="font-medium">{secret.label}</span>
        {!secret.hasValue && (
          <Chip tone="gray" size="sm" title="Nothing is stored here — the description says where it lives">
            reference only
          </Chip>
        )}
        <span className="ml-auto flex items-center gap-1">
          {secret.hasValue && (
            <IconButton
              label={value ? "Hide" : "Reveal — needs your password, shows for 5 minutes"}
              disabled={busy}
              onClick={() => (value ? hide() : void reveal())}
            >
              <Eye size={15} className={cn(value && "text-primary-link")} />
            </IconButton>
          )}
          <IconButton
            label={secret.hasValue && !unlocked ? "Edit secret — needs your password" : "Edit secret"}
            onClick={onEdit}
          >
            <Pencil size={15} />
          </IconButton>
          <IconButton
            label={unlocked ? "Delete secret" : "Delete secret — needs your password"}
            className="hover:text-danger"
            onClick={onDelete}
          >
            <Trash2 size={15} />
          </IconButton>
        </span>
      </div>
      {secret.description && (
        <p className="mt-0.5 whitespace-pre-wrap text-[12px] text-muted">{secret.description}</p>
      )}
      {error && <p className="mt-1 text-[12px] text-danger-text">{error}</p>}
      {value !== null && (
        <div className="mt-2 rounded-(--radius-field) border border-[#e0d3b8] bg-[#fdf8ee] p-2">
          <pre className="whitespace-pre-wrap break-all font-mono text-[12px] text-ink-700">
            {value}
          </pre>
          <div className="mt-1.5 flex gap-2">
            <button
              type="button"
              className="text-[12px] font-medium text-primary-link hover:underline"
              onClick={() => void navigator.clipboard?.writeText(value)}
            >
              Copy
            </button>
            <button
              type="button"
              className="text-[12px] text-muted hover:underline"
              onClick={hide}
            >
              Hide now
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Re-authentication. The password is the viewer's OWN login password — nothing new to remember. */
function UnlockModal({ clientId, onClose }: { clientId: string; onClose: () => void }) {
  const unlock = useUnlockSecrets(clientId);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      await unlock.mutateAsync({ password });
      setPassword(""); // don't leave it in state a moment longer than needed
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not unlock");
    }
  };

  return (
    <Modal
      title="Unlock this client's secrets"
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!password || unlock.isPending} onClick={() => void submit()}>
            {unlock.isPending ? "Checking…" : "Unlock for 5 minutes"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[13px] text-muted">
          Enter <strong>your own</strong> password. The window lasts five minutes and covers this
          client only — every look is written to the access log.
        </p>
        <FormField label="Your password" htmlFor="secret-pass">
          <Input
            id="secret-pass"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && password && void submit()}
          />
        </FormField>
        {error && <p className="text-[12px] text-danger-text">{error}</p>}
      </div>
    </Modal>
  );
}

/**
 * One plain form. Editing LOADS the real value into the field, so what you see is what is stored
 * and you change it like any other text (user, 2026-08-03). The earlier version left the box empty
 * and explained in prose what empty meant — "keep the old one" on edit, "store nothing" on create,
 * plus a checkbox to delete the value — three rules for one box, which is what made it hard.
 *
 * Now there is one rule in both modes: **the field is the value**. Empty means nothing is stored.
 * Because it shows a secret, opening it costs the same password as revealing does.
 */
function SecretForm({
  clientId,
  secret,
  onClose,
}: {
  clientId: string;
  secret?: ClientSecret;
  onClose: () => void;
}) {
  const save = useSaveSecret(clientId);
  const [label, setLabel] = useState(secret?.label ?? "");
  const [description, setDescription] = useState(secret?.description ?? "");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  // until the stored value is in the box, saving would send an empty field and WIPE it
  const [loading, setLoading] = useState(!!secret?.hasValue);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!secret?.hasValue) return;
    let alive = true;
    revealSecret(clientId, secret.id)
      .then((r) => alive && setValue(r.value))
      .catch((e) => {
        if (!alive) return;
        setLoadFailed(true);
        setError(e instanceof ApiError ? e.message : "Could not load the stored value");
      })
      .finally(() => alive && setLoading(false));
    // the plaintext dies with this form
    return () => {
      alive = false;
      setValue("");
    };
  }, [clientId, secret?.id, secret?.hasValue]);

  const submit = async () => {
    setError(null);
    try {
      await save.mutateAsync({
        id: secret?.id,
        input: {
          label: label.trim(),
          description: description.trim() || null,
          value: value.trim() ? value : null, // the field IS the value; empty stores nothing
        },
      });
      setValue("");
      // react-query keeps a mutation's `variables` — which here CONTAIN the secret — for its
      // garbage-collection window after the form unmounts. Reset drops them now (2026-08-03 audit).
      save.reset();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save");
    }
  };

  return (
    <Modal
      title={secret ? "Edit secret" : "New secret"}
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!label.trim() || save.isPending || loading || loadFailed}
            onClick={() => void submit()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="Name" htmlFor="secret-label">
          <Input
            id="secret-label"
            autoFocus
            placeholder="e.g. Tax portal login"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </FormField>
        <FormField label="Description" htmlFor="secret-desc">
          <Textarea
            id="secret-desc"
            className="h-[60px]"
            placeholder="What it opens, which company, who to ask…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <p className="mt-1 text-[12px] text-muted">Everyone who can open this client reads this.</p>
        </FormField>

        <FormField label="Value" htmlFor="secret-value">
          <Textarea
            id="secret-value"
            className="h-[90px] font-mono"
            placeholder={loading ? "loading…" : "login / password / notes"}
            autoComplete="off"
            spellCheck={false}
            value={value}
            disabled={loading || loadFailed}
            onChange={(e) => setValue(e.target.value)}
          />
          <p className="mt-1 text-[12px] text-muted">
            Clear the field to store nothing — the description alone then says where the secret
            lives.
          </p>
        </FormField>
        {error && <p className="text-[12px] text-danger-text">{error}</p>}
      </div>
    </Modal>
  );
}

/** What each logged action MEANS, in the words someone reading the log would use. */
const ACTION: Record<string, { text: string; tone: "gray" | "blue" | "amber" | "teal" }> = {
  created: { text: "Added", tone: "teal" },
  updated: { text: "Changed", tone: "gray" },
  deleted: { text: "Deleted", tone: "gray" },
  revealed: { text: "Viewed", tone: "blue" },
  unlock_failed: { text: "Wrong password", tone: "amber" },
};

function AuditModal({ clientId, onClose }: { clientId: string; onClose: () => void }) {
  const [data, setData] = useState<SecretAuditPage | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    fetchSecretAudit(clientId, page)
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load"));
  }, [clientId, page]);

  const rows = data?.items;
  // the log only grows, so it pages rather than loading a client's whole history at once
  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <Modal
      title="Access log"
      open
      size="md"
      onClose={onClose}
      footer={
        <>
          {data && data.total > data.pageSize && (
            <div className="mr-auto flex items-center gap-2 text-[12px] text-muted">
              <button
                type="button"
                className="rounded-(--radius-btn-sm) border border-border px-2 py-1 disabled:opacity-40"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                ← Previous
              </button>
              <span className="tabular-nums">
                Page {data.page} of {pageCount} · {data.total} entries
              </span>
              <button
                type="button"
                className="rounded-(--radius-btn-sm) border border-border px-2 py-1 disabled:opacity-40"
                disabled={page >= pageCount}
                onClick={() => setPage((p) => p + 1)}
              >
                Next →
              </button>
            </div>
          )}
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {error && <p className="text-[13px] text-danger-text">{error}</p>}
      {rows?.length === 0 && <p className="text-[13px] text-muted">Nothing recorded yet.</p>}
      <div className="space-y-1 text-[12px]">
        {rows?.map((r) => {
          const a = ACTION[r.action] ?? { text: r.action, tone: "gray" as const };
          return (
            <div
              key={r.id}
              className="flex items-center gap-2 border-b border-divider py-1.5 last:border-0"
            >
              <Chip tone={a.tone} size="sm">
                {a.text}
              </Chip>
              <span className="min-w-0 truncate text-ink-700">
                {r.label ?? (r.action === "unlock_failed" ? "" : "(deleted)")}
              </span>
              <span className="ml-auto flex-none text-muted">
                {r.byName} · {fmtDateTime(r.createdAt)}
              </span>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

import { useState } from "react";
import {
  PAYMENT_DETAILS_MAX,
  type PaymentDetails,
  type UpdatePaymentDetailsInput,
} from "@shared/schema/payment-details";
import { useAuth } from "@/app/auth";
import { cn } from "@/shared/lib/cn";
import { Button, IconButton } from "@/shared/ui/button";
import { FormField, Input, Textarea } from "@/shared/ui/field";
import { IconArchive, IconDefault, IconEdit } from "@/shared/ui/icons";
import {
  useArchivePaymentDetails,
  useCreatePaymentDetails,
  useMakePaymentDetailsDefault,
  usePaymentDetails,
  useUpdatePaymentDetails,
} from "./payment-details.api";

/**
 * **Settings → Invoices → Payment details** (payments.md §10): the sets an invoice can ask to be
 * paid into, one of them the default. Readable by whoever has Settings, changed by an admin only,
 * like the invoice details above it. An invoice keeps the text it was issued with, so an edit here
 * reaches the next invoices, never the ones already sent.
 */
export function PaymentDetailsSection() {
  const { data, isError, refetch } = usePaymentDetails();
  const isAdmin = useAuth().user?.role === "admin";
  const [editing, setEditing] = useState<string | "new" | null>(null);

  // a failed refetch keeps the list it has, and an open form with it
  if (!data) {
    return isError ? (
      <div className="flex items-center gap-3">
        <p className="text-[13px] text-danger-text">The payment details did not load.</p>
        <Button variant="secondary" size="sm" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    ) : (
      <p className="text-[13px] text-muted">Loading…</p>
    );
  }

  const live = data.filter((set) => !set.archivedAt);
  const archived = data.filter((set) => set.archivedAt);

  return (
    <div className="space-y-3">
      {live.length === 0 && (
        <p className="text-[13px] text-muted">
          No payment details yet, so invoices print no way to pay.
        </p>
      )}
      {live.map((set) =>
        editing === set.id ? (
          <EditSet key={set.id} set={set} onDone={() => setEditing(null)} />
        ) : (
          <SetCard key={set.id} set={set} isAdmin={isAdmin} onEdit={() => setEditing(set.id)} />
        ),
      )}

      {isAdmin && editing === "new" && <AddSet onDone={() => setEditing(null)} />}
      {isAdmin && editing !== "new" && (
        <Button variant="secondary" size="sm" onClick={() => setEditing("new")}>
          Add payment details
        </Button>
      )}
      {!isAdmin && <p className="text-[12px] text-muted">Only an admin changes these.</p>}

      {archived.length > 0 && (
        <details className="text-[13px]">
          <summary className="cursor-pointer text-muted">Archived ({archived.length})</summary>
          <div className="mt-2 space-y-2">
            {archived.map((set) => (
              <SetCard key={set.id} set={set} isAdmin={false} />
            ))}
          </div>
        </details>
      )}

      <p className="text-[12px] text-muted">An invoice keeps the text it was issued with.</p>
    </div>
  );
}

function SetCard({
  set,
  isAdmin,
  onEdit,
}: {
  set: PaymentDetails;
  isAdmin: boolean;
  onEdit?: () => void;
}) {
  const makeDefault = useMakePaymentDetailsDefault();
  const archive = useArchivePaymentDetails();
  // on the card it is about, which on a phone is where the eye is
  const [error, setError] = useState<string | null>(null);
  const isInUse = set.clients > 0;

  const act = (run: () => Promise<unknown>) => {
    setError(null);
    run().catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not do that"));
  };

  return (
    <div
      className={cn(
        "rounded-(--radius-field) border border-border p-3",
        set.archivedAt && "opacity-70",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[14px] font-medium break-words">{set.name}</span>
          {set.isDefault && (
            <span className="rounded-(--radius-chip) bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary-link">
              default
            </span>
          )}
          <span className="text-[12px] text-muted">
            {set.clients === 1 ? "1 client" : `${set.clients} clients`}
          </span>
        </div>
        {isAdmin && (
          <div className="flex shrink-0 items-center gap-1">
            <IconButton label="Edit these payment details" onClick={onEdit}>
              <IconEdit />
            </IconButton>
            <IconButton
              label={set.isDefault ? "The default set" : "Make this the default"}
              disabled={makeDefault.isPending || set.isDefault}
              className={cn(set.isDefault && "text-primary-link hover:text-primary-link")}
              onClick={() => act(() => makeDefault.mutateAsync(set.id))}
            >
              <IconDefault fill={set.isDefault ? "currentColor" : "none"} />
            </IconButton>
            <IconButton
              label={
                set.isDefault
                  ? "Make another set the default first"
                  : isInUse
                    ? "Move its clients to another set first"
                    : "Archive"
              }
              danger
              disabled={archive.isPending || set.isDefault || isInUse}
              onClick={() => {
                if (window.confirm(`Archive “${set.name}”?`)) {
                  act(() => archive.mutateAsync(set.id));
                }
              }}
            >
              <IconArchive />
            </IconButton>
          </div>
        )}
      </div>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-normal text-ink-700">
        {set.details}
      </p>
      {error && (
        <p role="alert" className="mt-1.5 text-[12px] text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}

function AddSet({ onDone }: { onDone: () => void }) {
  const create = useCreatePaymentDetails();
  return (
    <SetForm
      initial={{ name: "", details: "" }}
      isPending={create.isPending}
      error={create.error?.message ?? null}
      onCancel={onDone}
      onSave={(draft) => create.mutate(draft, { onSuccess: onDone })}
    />
  );
}

/**
 * Sends only what was changed in THIS form, compared with what it opened with, so a colleague's
 * edit of the other box that arrives meanwhile is not sent back over.
 */
function EditSet({ set, onDone }: { set: PaymentDetails; onDone: () => void }) {
  const update = useUpdatePaymentDetails();
  const [opened] = useState(() => ({ name: set.name, details: set.details }));
  return (
    <SetForm
      initial={opened}
      isPending={update.isPending}
      error={update.error?.message ?? null}
      onCancel={onDone}
      onSave={(draft) => {
        const input: UpdatePaymentDetailsInput = {};
        if (draft.name !== opened.name) input.name = draft.name;
        if (draft.details !== opened.details) input.details = draft.details;
        if (Object.keys(input).length === 0) return onDone();
        update.mutate({ id: set.id, input }, { onSuccess: onDone });
      }}
    />
  );
}

type Draft = { name: string; details: string };

function SetForm({
  initial,
  isPending,
  error,
  onSave,
  onCancel,
}: {
  initial: Draft;
  isPending: boolean;
  error: string | null;
  onSave: (draft: Draft) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [details, setDetails] = useState(initial.details);
  const draft = { name: name.trim(), details: details.trim() };

  return (
    <div className="space-y-3 rounded-(--radius-field) border border-border p-3">
      <FormField label="Name" htmlFor="payment-details-name">
        <Input
          id="payment-details-name"
          autoFocus
          placeholder="US clients, International"
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </FormField>
      <FormField label="What the invoice prints" htmlFor="payment-details-text">
        <Textarea
          id="payment-details-text"
          className="h-[120px]"
          placeholder="Bank, account and routing numbers, Zelle"
          maxLength={PAYMENT_DETAILS_MAX}
          value={details}
          onChange={(e) => setDetails(e.target.value)}
        />
      </FormField>
      {error && (
        <p role="alert" className="text-[12px] text-danger-text">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          disabled={!draft.name || !draft.details || isPending}
          onClick={() => onSave(draft)}
        >
          Save
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

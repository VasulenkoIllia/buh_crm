import { useEffect, useState } from "react";
import type { Invoice } from "@shared/schema/payment";
import { useCatalog } from "@/modules/catalog";
import { useClient, useClients } from "@/modules/clients";
import { useAssignees } from "@/modules/tasks";
import { todayPlus } from "@/shared/lib/format";
import { parseMoney } from "@/shared/lib/money";
import { AssigneePicker } from "@/shared/ui/assignee-picker";
import { Button } from "@/shared/ui/button";
import { ClearButton } from "@/shared/ui/clear-button";
import { FormField, Input, Textarea } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { RowButton } from "@/shared/ui/row-button";
import { SearchSelect } from "@/shared/ui/search-select";
import { Segmented } from "@/shared/ui/segmented";
import { BillToLine, useBillTo } from "./bill-to-field";
import {
  invoiceDefaults,
  jobDefaults,
  prefilledPosition,
  suggestedAmount,
} from "./invoice-defaults";
import {
  LinesEditor,
  draftTotal,
  linesProblem,
  toLineInput,
  type DraftLine,
} from "./invoice-lines-editor";
import { JobChoiceField, useJobChoice } from "./job-picker";
import { useCreateInvoice, useLastRate } from "./payments.api";

/** Compact client search — the invoice always belongs to exactly one client. */
function ClientPicker({
  clientId,
  onPick,
}: {
  clientId: string | null;
  onPick: (id: string | null) => void;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const { data } = useClients({ tab: "all", search, pageSize: 8 }, { enabled: open });
  const picked = useClient(clientId ?? undefined);

  if (clientId) {
    return (
      <div className="flex h-9 items-center gap-2 rounded-(--radius-field) border border-border px-3 text-[14px]">
        <span className="truncate">{picked.data?.displayName ?? "…"}</span>
        <ClearButton
          label="Clear the client"
          className="ml-auto"
          onClick={() => onPick(null)}
        />
      </div>
    );
  }

  return (
    <div className="relative">
      <Input
        placeholder="Search clients…"
        value={search}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setSearch(e.target.value);
          setOpen(true);
        }}
      />
      {open && (data?.items.length ?? 0) > 0 && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-(--radius-field) border border-border bg-surface shadow-(--shadow-card)">
          {data?.items.map((c) => (
            <RowButton
              key={c.id}
              className="px-3 py-2 text-[13px]"
              onClick={() => {
                onPick(c.id);
                setOpen(false);
              }}
            >
              {c.displayName}
            </RowButton>
          ))}
        </div>
      )}
    </div>
  );
}

export function NewInvoiceModal({
  presetClientId,
  presetJobId,
  onClose,
  onCreated,
}: {
  presetClientId?: string;
  /** a job's card sent us here: the form opens on that job */
  presetJobId?: string;
  onClose: () => void;
  onCreated?: (invoice: Invoice) => void;
}) {
  const createInvoice = useCreateInvoice();
  const { data: catalog } = useCatalog();
  const { data: assignees } = useAssignees();

  const [clientId, setClientId] = useState<string | null>(presetClientId ?? null);
  const [subscriptionId, setSubscriptionId] = useState("");
  const [description, setDescription] = useState("");
  // null = untouched, for all three: the form shows what the service suggests, and goes on
  // following it. Once somebody types, the value is theirs and no later pick replaces it.
  const [amount, setAmount] = useState<string | null>(null);
  const [typedLines, setTypedLines] = useState<DraftLine[] | null>(null);
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [itemised, setItemised] = useState(false);
  const [noDueDate, setNoDueDate] = useState(false);
  const [mode, setMode] = useState<"invoice" | "with_task" | "job">(
    presetJobId ? "job" : "invoice",
  );
  const [taskTitle, setTaskTitle] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const client = useClient(clientId ?? undefined);
  const serviceName = (id: string) => catalog?.find((s) => s.id === id)?.name ?? "Service";
  const subscriptions = (client.data?.subscriptions ?? []).filter((s) => s.active);

  const jobChoice = useJobChoice(clientId, mode === "job", presetJobId);
  const { job } = jobChoice;
  // a job decides the service, as it does on the server. Its own, even when it has none: the form's
  // service is usually the one it opened on, and those terms have nothing to do with this job
  const subscription =
    subscriptions.find((s) => s.id === (job ? job.subscriptionId : subscriptionId)) ?? null;
  const serviceDefaults = subscription
    ? invoiceDefaults(
        subscription,
        catalog?.find((s) => s.id === subscription.serviceId),
      )
    : null;
  const defaults = job ? jobDefaults(serviceDefaults, job) : serviceDefaults;
  // asked as soon as there is a client, so the rate is there when Positions opens: the first
  // keystroke in the list makes the list theirs, and a rate that lands after it would be lost
  const { data: lastRate } = useLastRate(clientId);
  const lines = typedLines ?? [prefilledPosition(defaults, lastRate?.unitRate ?? null)];
  const shownAmount = amount ?? suggestedAmount(defaults);
  const suggestedDue = defaults?.dueDays != null ? todayPlus(defaults.dueDays) : "";
  const shownDueDate = noDueDate ? "" : (dueDate ?? suggestedDue);
  const billTo = useBillTo(client.data?.companies ?? []);
  const companyId = job
    ? job.companyId
    : billTo.picked
      ? billTo.picked.companyId
      : (subscription?.companyId ?? null);

  // open on the client's default service — the one they're usually billed for
  useEffect(() => {
    if (subscriptionId || subscriptions.length === 0) return;
    const preferred =
      subscriptions.find((s) => s.isDefault) ??
      (subscriptions.length === 1 ? subscriptions[0] : undefined);
    if (preferred) setSubscriptionId(preferred.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the picked client changes
  }, [client.data?.id]);

  // the same two shapes the editor offers, and the same rule: with positions on, they are the total
  const filled = lines.filter((l) => l.description.trim());
  const total = itemised ? draftTotal(filled) : parseMoney(shownAmount);

  async function submit() {
    setError(null);
    if (!clientId) return setError("Pick a client");
    if (mode === "job" && !job) return setError("Pick a job");
    if (itemised && filled.length === 0)
      return setError("Add at least one position, with a name");
    const problem = itemised ? linesProblem(filled) : null;
    if (problem) return setError(problem);
    if (total <= 0) return setError("Enter an amount");
    try {
      const invoice = await createInvoice.mutateAsync({
        clientId,
        subscriptionId: subscriptionId || null,
        description: description.trim() || undefined,
        amount: total,
        lines: itemised ? toLineInput(filled) : undefined,
        // a date sets it · "no due date" sends null · leaving it empty inherits the service preset
        dueDate: shownDueDate || (noDueDate ? null : undefined),
        withTask: mode === "with_task",
        taskTitle: taskTitle.trim() || undefined,
        assigneeIds: mode === "with_task" ? selected : [],
        taskId: job?.id,
        // only a pick is sent: untouched, the server follows the service just as the form did
        companyId: mode !== "job" && billTo.picked ? billTo.picked.companyId : undefined,
      });
      onCreated?.(invoice);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Modal
      title="New invoice"
      open
      onClose={onClose}
      // One width whatever is picked, so the dialog never jumps under the click (it used to grow
      // from 512 when Positions was chosen). The fields pair up: one under another they scrolled
      // by 260 on a 13-inch MacBook (owner, 2026-09-29). `fit` lets a long list of positions
      // scroll in place rather than push the form off the screen.
      size="lg"
      fit
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={createInvoice.isPending || (mode === "job" && jobChoice.isLoading)}
            onClick={() => void submit()}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-col gap-3.5">
        <div className="grid gap-3.5 sm:grid-cols-2">
          <FormField label="Client">
            <ClientPicker
              clientId={clientId}
              onPick={(id) => {
                setClientId(id);
                setSubscriptionId("");
                jobChoice.setJobId("");
                billTo.reset();
              }}
            />
          </FormField>

          {job ? (
            <FormField label="Service (from the job)">
              <Input disabled aria-label="Service" value={job.serviceName ?? "No service"} />
            </FormField>
          ) : (
            <FormField label="Service (optional)">
              <SearchSelect
                value={subscriptionId}
                onChange={setSubscriptionId}
                disabled={!clientId}
                placeholder={
                  clientId ? "Search this client's services…" : "Pick a client first"
                }
                emptyLabel="No service — a plain charge"
                options={
                  clientId
                    ? subscriptions.map((s) => ({
                        value: s.id,
                        label: s.companyId
                          ? `${serviceName(s.serviceId)} · ${client.data?.companies.find((c) => c.id === s.companyId)?.name ?? "company"}`
                          : serviceName(s.serviceId),
                      }))
                    : []
                }
              />
            </FormField>
          )}
        </div>

        {client.data && (
          <BillToLine
            client={client.data}
            companyId={companyId}
            locked={mode === "job"}
            onPick={billTo.pick}
          />
        )}

        <div className="grid gap-3.5 sm:grid-cols-2">
          <FormField label={itemised ? "Note on the invoice" : "Description"}>
            <Textarea
              className="h-[60px]"
              placeholder="What this invoice is for"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </FormField>

          <div className="flex gap-3">
            {!itemised && (
              <div className="flex-1">
                <FormField label="Amount">
                  <Input
                    inputMode="decimal"
                    placeholder="0.00"
                    value={shownAmount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </FormField>
              </div>
            )}
            <div className={itemised ? "flex-1" : "w-[190px]"}>
              {/* the switch sits on the label's line, so the date box lines up with its neighbours */}
              {/* the label's own classes without its margin: the row carries the one 6px gap,
                  the same as the Label above each neighbouring box */}
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <label htmlFor="inv-due" className="block text-[12px] font-medium text-ink-700">
                  Due date
                </label>
                <label className="flex items-center gap-1.5 text-[12px] text-muted">
                  <input
                    type="checkbox"
                    checked={noDueDate}
                    onChange={(e) => {
                      setNoDueDate(e.target.checked);
                      setDueDate(null);
                    }}
                  />
                  No due date
                </label>
              </div>
              <Input
                id="inv-due"
                type="date"
                value={shownDueDate}
                disabled={noDueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
              {!noDueDate && !shownDueDate && (
                <p className="mt-1 text-[11px] text-faint">empty = service default</p>
              )}
            </div>
          </div>
        </div>

        {/* The two choices on one row: how the money is written, and what else gets made. */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* The same choice the editor offers, so an invoice is made the way it is later corrected
              (user, 2026-08-21). Nothing about the toggle is stored — see InvoiceLine's comment. */}
          <Segmented
            className="w-auto"
            value={itemised ? "lines" : "flat"}
            onChange={(v) => setItemised(v === "lines")}
            options={[
              { value: "flat", label: "One amount" },
              { value: "lines", label: "Positions" },
            ]}
          />
          {/* wraps on a phone: three options beside their label ran 7px past the dialog at 390 */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[12px] font-medium text-ink-700">What to create</span>
            <Segmented
              className="w-auto"
              value={mode}
              onChange={setMode}
              options={[
                { value: "invoice", label: "Invoice only" },
                { value: "with_task", label: "Invoice + task" },
                { value: "job", label: "For a job" },
              ]}
            />
          </div>
        </div>

        {itemised && <LinesEditor lines={lines} onChange={setTypedLines} />}

        {mode === "job" && <JobChoiceField choice={jobChoice} total={total} />}

        {mode === "with_task" && (
          <div className="grid gap-3 rounded-(--radius-panel) bg-[#f7f8fa] p-3 sm:grid-cols-[240px_1fr]">
            <FormField label="Task name">
              <Input
                placeholder={description || "What has to be done"}
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
              />
            </FormField>
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-ink-700">Assign to</div>
              <AssigneePicker
                users={assignees ?? []}
                selected={(id) => selected.includes(id)}
                onToggle={(id) =>
                  setSelected((prev) =>
                    prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
                  )
                }
              />
            </div>
            <p className="text-[12px] text-faint sm:col-span-2">
              The job opens in the New column with this invoice already attached — its price is
              locked to the invoice.
            </p>
          </div>
        )}

        {error && <p className="text-[12px] text-danger-text">{error}</p>}
      </div>
    </Modal>
  );
}

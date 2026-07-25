import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Link } from "react-router-dom";
import type { Task, TimeEntry, UpdateTaskInput } from "@shared/schema/task";
import { useAuth } from "@/app/auth";
import { ServiceChip, useCatalog } from "@/modules/catalog";
import { ClientFormModal, useClient, useClients } from "@/modules/clients";
import { LeadFormModal, useLeads } from "@/modules/leads";
import { useSettings } from "@/modules/settings";
import { ApiError } from "@/shared/lib/api";
import { cn } from "@/shared/lib/cn";
import { AssigneePicker } from "@/shared/ui/assignee-picker";
import { Button } from "@/shared/ui/button";
import { ChecklistEditor } from "@/shared/ui/checklist-editor";
import { Chip } from "@/shared/ui/chip";
import { Input, Label, Select, Textarea } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { pillCls } from "@/shared/ui/pill";
import { Segmented } from "@/shared/ui/segmented";
import { DoneToggle, TaskTimerButton } from "./task-controls";
import { fmtDuration } from "./timer";
import {
  useAddComment,
  useAddTimeEntry,
  useArchiveTask,
  useAssignees,
  useCreateTask,
  useDeleteComment,
  useDeleteTimeEntry,
  useSetSubtasks,
  useTaskColumns,
  useUpdateTask,
  useUpdateTimeEntry,
} from "./tasks.api";

const todayPlus = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

// ── create / edit ────────────────────────────────────────────────────────────

/** A resolved task target: a client (through one of its subscriptions) or a lead. */
export type Target =
  | { kind: "client"; id: string; label: string }
  | { kind: "lead"; id: string; label: string };

export function TaskFormModal({
  task,
  preset,
  presetColumnId,
  onClose,
}: {
  task?: Task;
  /** pre-target a new task (from a client/lead card's "+ New task") */
  preset?: Target;
  /** pre-select the kanban column (from a column's "+" button) */
  presetColumnId?: string;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const { data: services } = useCatalog();
  const { data: settings } = useSettings();
  const { data: team } = useAssignees();
  const { data: columns } = useTaskColumns();
  const create = useCreateTask();
  const update = useUpdateTask();

  // editing only touches workflow fields — targeting is create-only (no re-targeting)
  const editing = !!task;
  const [type, setType] = useState<"client" | "internal">(
    task ? (task.clientId ? "client" : "internal") : "client",
  );
  const [target, setTarget] = useState<Target | null>(
    task?.clientId
      ? { kind: "client", id: task.clientId, label: "" }
      : task?.leadId
        ? { kind: "lead", id: task.leadId, label: "" }
        : (preset ?? null),
  );
  const [subscriptionId, setSubscriptionId] = useState(task?.subscriptionId ?? "");
  const [title, setTitle] = useState(task?.title ?? "");
  const [priorityId, setPriorityId] = useState(task?.priorityId ?? "");
  const [statusColumnId, setStatusColumnId] = useState(task?.statusColumnId ?? presetColumnId ?? "");
  const [deadline, setDeadline] = useState(task?.deadline ? task.deadline.slice(0, 10) : "");
  const [plannedMinutes, setPlannedMinutes] = useState<number | null>(task?.plannedMinutes ?? null);
  const [amount, setAmount] = useState<number | null>(task?.amount ?? null);
  const [description, setDescription] = useState(task?.description ?? "");
  // new task → the creator is the default assignee (removable); edit → keep current
  const [assignees, setAssignees] = useState<Set<string>>(
    () => new Set(task ? task.assignees : user ? [user.id] : []),
  );
  const [subtasks, setSubtasks] = useState<string[]>([]);
  const [leadFormOpen, setLeadFormOpen] = useState(false);
  const [clientFormOpen, setClientFormOpen] = useState(false);

  // fetch the picked client directly (list is capped at pageSize 100) — includes subscriptions
  const { data: client } = useClient(target?.kind === "client" ? target.id : undefined);
  const subscription = client?.subscriptions.find((s) => s.id === subscriptionId);
  const subService = services?.find((s) => s.id === subscription?.serviceId);
  const isOneTimeJob = subService?.type === "one_time";
  const companyName = subscription?.companyId
    ? client?.companies.find((c) => c.id === subscription.companyId)?.name
    : null;

  const pickSubscription = (id: string) => {
    setSubscriptionId(id);
    const sub = client?.subscriptions.find((s) => s.id === id);
    const svc = services?.find((s) => s.id === sub?.serviceId);
    // one-time container: the per-client default job price prefills (editable per job)
    setAmount(svc?.type === "one_time" ? (sub?.amount ?? null) : null);
  };

  const applyPreset = (templateId: string) => {
    const tpl = subService?.taskTemplates.find((t) => t.id === templateId);
    if (!tpl) return;
    if (!title.trim()) setTitle(tpl.name);
    if (tpl.deadlineOffsetDays != null) setDeadline(todayPlus(tpl.deadlineOffsetDays));
    if (tpl.estimatedMinutes != null) setPlannedMinutes(tpl.estimatedMinutes);
    // prefill the checklist from the preset (don't clobber steps already typed)
    if (subtasks.length === 0 && tpl.defaultChecklist.length) setSubtasks([...tpl.defaultChecklist]);
  };

  const toggleAssignee = (id: string) =>
    setAssignees((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const mutation = editing ? update : create;
  const serverError = mutation.error instanceof ApiError ? mutation.error.message : null;

  // spell out what's still missing so a disabled button never feels mysterious
  // (client task needs a client + one of its subscriptions, or a lead)
  const missing = !editing
    ? [
        !title.trim() && "a task name",
        type === "client" && !target && "a client or lead",
        type === "client" && target?.kind === "client" && !subscriptionId && "a service",
      ].filter(Boolean)
    : [!title.trim() && "a task name"].filter(Boolean);
  const canSave = missing.length === 0 && !mutation.isPending;

  const save = async () => {
    const workflow = {
      title: title.trim(),
      priorityId: priorityId || undefined,
      statusColumnId: statusColumnId || undefined,
      deadline: deadline || null,
      plannedMinutes,
      description: description.trim() || null,
      assignees: [...assignees],
    };
    try {
      if (editing) {
        await update.mutateAsync({
          id: task!.id,
          input: isOneTimeJob && !task!.invoice ? { ...workflow, amount } : workflow,
        });
      } else {
        const steps = subtasks.map((s) => s.trim()).filter(Boolean);
        await create.mutateAsync({
          ...workflow,
          clientId: type === "client" && target?.kind === "client" ? target.id : null,
          leadId: type === "client" && target?.kind === "lead" ? target.id : null,
          subscriptionId:
            type === "client" && target?.kind === "client" ? subscriptionId || null : null,
          amount: isOneTimeJob ? amount : null,
          subtasks: steps.length ? steps : undefined,
        });
      }
      onClose();
    } catch {
      /* surfaced via serverError below */
    }
  };

  // creating a client/lead inline pauses this modal, then drops the new target back in
  if (leadFormOpen) {
    return (
      <LeadFormModal
        open
        onClose={() => setLeadFormOpen(false)}
        onSaved={(lead) => {
          setTarget({ kind: "lead", id: lead.id, label: lead.name });
          setSubscriptionId("");
          setAmount(null);
        }}
      />
    );
  }
  if (clientFormOpen) {
    return (
      <ClientFormModal
        open
        onClose={() => setClientFormOpen(false)}
        onSaved={(c) => {
          setTarget({ kind: "client", id: c.id, label: c.displayName });
          setSubscriptionId("");
          setAmount(null);
        }}
      />
    );
  }

  return (
    <Modal
      title={task ? "Edit task" : "New task"}
      open
      onClose={onClose}
      footer={
        <>
          {missing.length > 0 && (
            <span className="mr-auto text-[12px] text-muted">Add {missing.join(", ")} to continue</span>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={() => void save()}>
            {mutation.isPending ? "Saving…" : task ? "Save" : "Create task"}
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        {editing && (
          <p className="rounded-(--radius-field) bg-[#eef1fb] px-3 py-2 text-[12px] text-primary-link">
            {task!.kind === "sub"
              ? "📅 Generated from a subscription — target & billing are managed there."
              : "Editing workflow fields — the target (client/service) can't be changed here."}
          </p>
        )}

        {!editing && (
          <div>
            <Label>Task type</Label>
            <Segmented
              value={type}
              onChange={(v) => {
                setType(v as "client" | "internal");
                setTarget(null);
                setSubscriptionId("");
                setAmount(null);
              }}
              options={[
                { value: "client", label: "Client / lead work" },
                { value: "internal", label: "Internal" },
              ]}
            />
          </div>
        )}

        {!editing && type === "client" && (
          <>
            <div>
              <Label>Client or lead</Label>
              <ClientLeadSearch
                value={target}
                onPick={(t) => {
                  setTarget(t);
                  setSubscriptionId("");
                  setAmount(null);
                }}
                onClear={() => {
                  setTarget(null);
                  setSubscriptionId("");
                  setAmount(null);
                }}
                onNewClient={() => setClientFormOpen(true)}
                onNewLead={() => setLeadFormOpen(true)}
              />
            </div>

            {target?.kind === "client" &&
              (client ? (
                client.subscriptions.filter((s) => s.active).length > 0 ? (
                  <div>
                    <Label>Which service (company is set by it)</Label>
                    <Select value={subscriptionId} onChange={(e) => pickSubscription(e.target.value)}>
                      <option value="">— pick a service —</option>
                      {client.subscriptions
                        .filter((s) => s.active)
                        .map((s) => {
                          const svc = services?.find((x) => x.id === s.serviceId);
                          const co = s.companyId
                            ? client.companies.find((c) => c.id === s.companyId)?.name
                            : "main";
                          return (
                            <option key={s.id} value={s.id}>
                              {svc?.name ?? "service"} · {co}
                              {svc?.type === "one_time" ? " · one-time (billable)" : " · included"}
                            </option>
                          );
                        })}
                    </Select>
                  </div>
                ) : (
                  <p className="rounded-(--radius-field) bg-[#fdf5f5] px-3 py-2 text-[12px] text-danger-text">
                    This client has no active services — add one on the client card first.
                  </p>
                )
              ) : null)}

            {subscription && (
              <p className="rounded-(--radius-field) bg-[#f7f8fa] px-3 py-2 text-[12px] text-muted">
                {companyName ? `Company: ${companyName}. ` : "Client (main). "}
                {isOneTimeJob
                  ? "One-time job — an invoice is issued per the service rule."
                  : "Extra work included in the subscription — no charge."}
              </p>
            )}

            {isOneTimeJob && subService && subService.taskTemplates.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                <span className="text-muted">Preset:</span>
                {subService.taskTemplates.map((t) => (
                  <button key={t.id} type="button" className={pillCls(false)} onClick={() => applyPreset(t.id)}>
                    {t.name}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        <div>
          <Label>Task name</Label>
          <Input value={title} placeholder="e.g. Prepare the VAT report" onChange={(e) => setTitle(e.target.value)} />
        </div>

        {isOneTimeJob && (!editing || !task!.invoice) && (
          <div className="rounded-(--radius-field) bg-[#f7f8fa] p-3">
            <Label>Price for this job</Label>
            <div className="flex items-center gap-2">
              <span className="text-[13px] text-muted">$</span>
              <Input
                className="w-28"
                type="number"
                min={0}
                value={amount != null ? amount / 100 : ""}
                onChange={(e) =>
                  setAmount(e.target.value ? Math.round(Number(e.target.value) * 100) : null)
                }
              />
            </div>
            <p className="mt-1 text-[12px] text-faint">
              An invoice is issued for this amount per the service billing rule.
            </p>
          </div>
        )}

        {editing && task!.invoice && (
          <p className="rounded-(--radius-field) bg-[#eef1fb] px-3 py-2 text-[12px] text-primary-link">
            💰 Invoice {task!.invoice.number} · ${(task!.invoice.amount / 100).toFixed(2)} — price locked.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Column</Label>
            <Select value={statusColumnId} onChange={(e) => setStatusColumnId(e.target.value)}>
              <option value="">New (default)</option>
              {(columns ?? [])
                .filter((c) => !c.isFixed)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </Select>
          </div>
          <div>
            <Label>Priority</Label>
            <Select value={priorityId} onChange={(e) => setPriorityId(e.target.value)}>
              <option value="">Default</option>
              {(settings?.priorities ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div>
          <Label>Planned time (min)</Label>
          <Input
            type="number"
            min={1}
            value={plannedMinutes ?? ""}
            onChange={(e) => setPlannedMinutes(e.target.value ? Number(e.target.value) : null)}
          />
        </div>

        <div>
          <Label>Deadline (optional)</Label>
          <div className="flex flex-wrap items-center gap-1.5">
            {[1, 2, 5].map((d) => (
              <button
                key={d}
                type="button"
                className={pillCls(deadline === todayPlus(d))}
                onClick={() => setDeadline(todayPlus(d))}
              >
                +{d} days
              </button>
            ))}
            <button type="button" className={pillCls(deadline === "")} onClick={() => setDeadline("")}>
              none
            </button>
            <Input
              className="w-36"
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
            />
          </div>
        </div>

        <div>
          <Label>Assignees</Label>
          <AssigneePicker
            users={team ?? []}
            selected={(id) => assignees.has(id)}
            onToggle={toggleAssignee}
          />
        </div>

        <div>
          <Label>Description</Label>
          <Textarea
            className="h-[74px]"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div>
          <Label>Checklist</Label>
          <ChecklistEditor value={subtasks} onChange={setSubtasks} />
        </div>

        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
      </div>
    </Modal>
  );
}

/**
 * Dynamic-search combobox over clients + in-process leads. The picked value
 * lives in the input itself — re-pick freely by editing the text (no separate
 * "change" control); create a client or a lead inline.
 */
function ClientLeadSearch({
  value,
  onPick,
  onClear,
  onNewClient,
  onNewLead,
}: {
  value: Target | null;
  onPick: (t: Target) => void;
  onClear: () => void;
  onNewClient: () => void;
  onNewLead: () => void;
}) {
  const [query, setQuery] = useState(value?.label ?? "");
  const [open, setOpen] = useState(false);
  // reflect an externally-set target (e.g. a just-created client) in the field
  useEffect(() => {
    if (value) {
      setQuery(value.label);
      setOpen(false);
    }
  }, [value]);

  const q = query.trim().toLowerCase();
  const committed = value?.label === query; // showing the current pick, not a fresh search
  const searching = q.length > 0 && !committed;
  // fetch only while the dropdown is open: search results when typing, else a
  // short suggestion list (most-recent clients) — like a normal combobox
  const { data: clientsResp } = useClients(
    { tab: "all", search: searching ? query.trim() : undefined, pageSize: searching ? 20 : 6 },
    { enabled: open },
  );
  const { data: leads } = useLeads();

  const clientMatches = clientsResp?.items ?? [];
  const leadMatches = (leads ?? [])
    .filter((l) => l.outcome === "in_process")
    .filter((l) => !searching || l.name.toLowerCase().includes(q))
    .slice(0, searching ? 6 : 4);

  const onType = (v: string) => {
    setQuery(v);
    setOpen(true);
    if (value) onClear(); // editing the text drops the current pick → re-searching
  };

  return (
    <div className="relative">
      <div className="relative">
        <Input
          className={cn("w-full pr-16", value && "border-primary font-medium")}
          placeholder="Search or pick a client / lead…"
          value={query}
          onChange={(e) => onType(e.target.value)}
          onFocus={(e) => {
            e.target.select();
            setOpen(true); // clicking the field opens the suggestion dropdown
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)} // let an option click land first
        />
        {value ? (
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-medium text-[#0e7a6b]">
            ✓ {value.kind}
          </span>
        ) : (
          query && (
            <button
              type="button"
              aria-label="Clear"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[13px] text-muted hover:text-danger"
              onClick={() => {
                setQuery("");
                onClear();
              }}
            >
              ×
            </button>
          )
        )}
      </div>
      <div className="mt-1 flex gap-3 text-[12px]">
        <button type="button" className="font-medium text-primary-link hover:underline" onClick={onNewClient}>
          + New client
        </button>
        <button type="button" className="font-medium text-primary-link hover:underline" onClick={onNewLead}>
          + New lead
        </button>
      </div>
      {open && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-(--radius-field) border border-border bg-surface shadow-(--shadow-card)">
          {!searching && (clientMatches.length > 0 || leadMatches.length > 0) && (
            <p className="px-3 pt-2 pb-1 text-[11px] font-medium uppercase tracking-[.4px] text-muted-400">
              Suggestions
            </p>
          )}
          {clientMatches.map((c) => (
            <button
              key={c.id}
              type="button"
              className="flex w-full items-center gap-2 border-b border-divider px-3 py-2 text-left text-[13px] last:border-0 hover:bg-divider/40"
              onMouseDown={(e) => e.preventDefault()} // keep focus so onClick fires before blur
              onClick={() => onPick({ kind: "client", id: c.id, label: c.displayName })}
            >
              <span className="font-medium">{c.displayName}</span>
              <span className="text-[11px] text-muted">client</span>
            </button>
          ))}
          {leadMatches.map((l) => (
            <button
              key={l.id}
              type="button"
              className="flex w-full items-center gap-2 border-b border-divider px-3 py-2 text-left text-[13px] last:border-0 hover:bg-divider/40"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick({ kind: "lead", id: l.id, label: l.name })}
            >
              <span className="font-medium">{l.name}</span>
              <span className="text-[11px] text-[#8b6a1f]">lead · free</span>
            </button>
          ))}
          {clientMatches.length === 0 && leadMatches.length === 0 && (
            <p className="px-3 py-3 text-[12px] text-muted">
              {searching ? "No matches — try another name." : "No clients or leads yet."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── details ──────────────────────────────────────────────────────────────────

export function TaskDetailsModal({ task, onClose }: { task: Task; onClose: () => void }) {
  const { user } = useAuth();
  const { data: clientsResp } = useClients({ tab: "all", pageSize: 100 });
  const { data: services } = useCatalog();
  const { data: settings } = useSettings();
  const { data: team } = useAssignees();
  const { data: columns } = useTaskColumns();
  const update = useUpdateTask();
  const archive = useArchiveTask();

  const isAdmin = user?.role === "admin";
  const client = clientsResp?.items.find((c) => c.id === task.clientId);
  const service = services?.find((s) => s.id === task.serviceId);
  const userName = (id: string | null) => {
    const u = team?.find((x) => x.id === id);
    return u ? `${u.firstName} ${u.lastName}` : "—";
  };
  // every field edits inline → one small PATCH per change (each sends only its own field)
  const patch = (input: UpdateTaskInput) => update.mutate({ id: task.id, input });
  const updateError = update.error instanceof ApiError ? update.error.message : null;

  const editableAmount = task.kind === "once" && !task.invoice;
  // a completed task is a locked snapshot — everything read-only until Reopen.
  // (Admin can still correct the time log below — that's a deliberate exception.)
  const locked = task.done;
  const currentPriority = settings?.priorities.find((p) => p.id === task.priorityId);
  // tracked has run past the planned estimate → flag it in the card
  const trackedOver =
    task.plannedMinutes != null && task.trackedSeconds > task.plannedMinutes * 60;
  const createdBy = task.createdById
    ? task.createdById === user?.id
      ? "you"
      : userName(task.createdById)
    : "auto (generated)";
  const toggleAssignee = (id: string) =>
    patch({
      assignees: task.assignees.includes(id)
        ? task.assignees.filter((x) => x !== id)
        : [...task.assignees, id],
    });

  return (
    <Modal
      title="Task"
      size="xl"
      open
      onClose={onClose}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              if (window.confirm("Archive this task?")) {
                archive
                  .mutateAsync(task.id)
                  .then(onClose)
                  .catch(() => {});
              }
            }}
          >
            Archive
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* title (inline) + done / completed control */}
        <div className="flex items-start gap-3">
          <InlineTitle value={task.title} disabled={locked} onSave={(title) => patch({ title })} />
          {locked ? (
            // completed = a clear status badge + an explicit Reopen (un-locks for editing)
            <div className="flex flex-none items-center gap-2">
              <span className="flex items-center gap-1 rounded-full bg-[#e6f4ea] px-3 py-1.5 text-[13px] font-semibold text-[#1f8f3a]">
                <Check size={15} strokeWidth={3} /> Completed
              </span>
              <button
                type="button"
                onClick={() => patch({ done: false })}
                disabled={update.isPending}
                title="Reopen — makes the task editable again"
                className="flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-[13px] font-medium text-ink-700 hover:bg-divider disabled:opacity-60"
              >
                ↩ Reopen
              </button>
            </div>
          ) : (
            // for a billable one-time job, don't let "done" fire (→ invoice) while an
            // unsaved price patch is still in flight — it would bill the stale amount
            <DoneToggle task={task} disabled={editableAmount && update.isPending} />
          )}
        </div>

        {/* an inline PATCH was rejected (e.g. an out-of-range value) — say so, don't fail silently */}
        {updateError && (
          <p className="rounded-(--radius-field) bg-[#fdf5f5] px-3 py-2 text-[12px] text-danger-text">
            {updateError}
          </p>
        )}

        {/* kind + billing + provenance chips */}
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          {task.kind === "sub" && <Chip tone="blue">📅 auto · {task.periodKey}</Chip>}
          {task.kind === "free" && !task.clientId && <Chip tone="amber">internal</Chip>}
          {task.kind === "free" && task.clientId && <Chip tone="teal">included in the plan</Chip>}
          {task.invoice && (
            <Chip tone="blue" strong>
              💰 {task.invoice.number}
            </Chip>
          )}
          <span className="text-muted-400">
            Created by <span className="text-ink-700">{createdBy}</span> ·{" "}
            {new Date(task.createdAt).toLocaleDateString("en-GB")}
          </span>
        </div>

        {/* two columns: left = task fields, right = activity (timer / checklist / log) */}
        <div className="grid gap-x-8 gap-y-6 md:grid-cols-[1.5fr_1fr]">
          {/* LEFT — task fields */}
          <div className="space-y-4">
            {/* inline meta grid */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px]">
              <Field label="Column">
            <Select
              value={task.statusColumnId}
              disabled={locked}
              onChange={(e) => patch({ statusColumnId: e.target.value })}
            >
              {(columns ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            {/* tint the control by the current priority so its color scheme is visible at a glance */}
            <Select
              value={task.priorityId}
              disabled={locked}
              onChange={(e) => patch({ priorityId: e.target.value })}
              className="font-medium"
              style={
                currentPriority
                  ? {
                      color: currentPriority.color,
                      borderColor: currentPriority.color,
                      backgroundColor: `${currentPriority.color}1a`,
                    }
                  : undefined
              }
            >
              {(settings?.priorities ?? []).map((p) => (
                <option key={p.id} value={p.id} style={{ color: p.color }}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Client">
            {client ? (
              <Link to={`/clients/${client.id}`} className="text-primary-link hover:underline">
                {client.displayName}
              </Link>
            ) : (
              <span className="text-muted">—</span>
            )}
          </Field>
          <Field label="Service">
            {service ? <ServiceChip name={service.name} color={service.color} /> : <span className="text-muted">—</span>}
          </Field>
          <Field label="Deadline">
            <Input
              className="w-40"
              type="date"
              disabled={locked}
              value={task.deadline ? task.deadline.slice(0, 10) : ""}
              onChange={(e) => patch({ deadline: e.target.value || null })}
            />
          </Field>
          <Field label="Planned / tracked">
            <div className="flex flex-wrap items-center gap-1.5">
              <InlineNumber
                value={task.plannedMinutes}
                disabled={locked}
                onSave={(v) => patch({ plannedMinutes: v })}
              />
              <span className="text-muted">min ·</span>
              <span
                className={cn(
                  "tabular-nums",
                  trackedOver ? "font-semibold text-danger-text" : "text-muted",
                )}
                title={trackedOver ? "Tracked time is over the planned estimate" : undefined}
              >
                {fmtDuration(task.trackedSeconds)}
              </span>
              {trackedOver && (
                <span className="rounded-(--radius-chip) bg-danger-soft px-1.5 py-[1px] text-[11px] font-medium text-danger-text">
                  over
                </span>
              )}
            </div>
          </Field>
          {editableAmount && (
            <Field label="Job price">
              <div className="flex items-center gap-1">
                <span className="text-muted">$</span>
                <InlineNumber
                  min={0}
                  disabled={locked}
                  value={task.amount != null ? task.amount / 100 : null}
                  onSave={(v) => patch({ amount: v != null ? Math.round(v * 100) : null })}
                />
              </div>
            </Field>
          )}
          {task.invoice && (
            <Field label="Invoice">
              <span className="font-medium text-primary-link">💰 {task.invoice.number}</span> · $
              {(task.invoice.amount / 100).toFixed(2)}
              {task.invoice.dueDate &&
                ` · due ${new Date(task.invoice.dueDate).toLocaleDateString("en-GB")}`}
            </Field>
          )}
        </div>

        <div>
          <Label>Assignees</Label>
          {/* assignees is a full-array replace read from the task prop; block a second
              toggle until the first PATCH's refetch lands (else it clobbers). Locked (done) → read-only. */}
          <AssigneePicker
            users={team ?? []}
            selected={(id) => task.assignees.includes(id)}
            onToggle={toggleAssignee}
            disabled={locked || update.isPending}
          />
        </div>

            <div>
              <Label>Description</Label>
              <InlineTextarea
                value={task.description ?? ""}
                disabled={locked}
                onSave={(d) => patch({ description: d || null })}
              />
            </div>
          </div>

          {/* RIGHT — activity: timer, checklist, work log */}
          <div className="space-y-5 md:border-l md:border-divider md:pl-6">
            {locked ? (
              <p className="rounded-(--radius-field) bg-[#f7f8fa] px-3 py-2.5 text-[13px] text-muted">
                ✓ Completed — reopen to track time or edit.
              </p>
            ) : (
              <TaskTimerButton task={task} />
            )}
            <SubtasksSection task={task} disabled={locked} />
            <TimeLog task={task} isAdmin={isAdmin} userName={userName} />
            <CommentsSection
              task={task}
              currentUserId={user?.id}
              isAdmin={isAdmin}
              userName={userName}
              disabled={locked}
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-[.4px] text-muted-400">{label}</div>
      <div className="text-ink-700">{children}</div>
    </div>
  );
}

/** Big inline title — saves on blur, ignores empty. `disabled` = read-only (locked task). */
function InlineTitle({
  value,
  onSave,
  disabled,
}: {
  value: string;
  onSave: (v: string) => void;
  disabled?: boolean;
}) {
  const [t, setT] = useState(value);
  useEffect(() => setT(value), [value]); // resync when the task refetches
  return (
    <textarea
      rows={1}
      disabled={disabled}
      className={cn(
        "min-w-0 flex-1 resize-none rounded-(--radius-field) border border-transparent bg-transparent px-1 py-0.5 text-[16px] font-semibold leading-snug focus:outline-none",
        !disabled && "hover:border-border focus:border-primary focus:bg-surface",
        disabled && "cursor-default text-ink-700 opacity-100",
      )}
      value={t}
      onChange={(e) => setT(e.target.value)}
      // Enter commits (a title is single-line) instead of inserting a newline
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      onBlur={() => {
        const v = t.trim();
        if (v && v !== value) onSave(v);
        else setT(value);
      }}
    />
  );
}

function InlineTextarea({
  value,
  onSave,
  disabled,
}: {
  value: string;
  onSave: (v: string) => void;
  disabled?: boolean;
}) {
  const [t, setT] = useState(value);
  useEffect(() => setT(value), [value]);
  return (
    <Textarea
      className="h-[70px]"
      disabled={disabled}
      value={t}
      onChange={(e) => setT(e.target.value)}
      onBlur={() => t !== value && onSave(t)}
    />
  );
}

/** Inline number — saves on blur; empty = null. Reverts NaN / below-`min` (no doomed PATCH). */
function InlineNumber({
  value,
  onSave,
  min = 1,
  disabled,
}: {
  value: number | null;
  onSave: (v: number | null) => void;
  min?: number;
  disabled?: boolean;
}) {
  const [t, setT] = useState(value != null ? String(value) : "");
  useEffect(() => setT(value != null ? String(value) : ""), [value]);
  const revert = () => setT(value != null ? String(value) : "");
  return (
    <Input
      className="w-20"
      type="number"
      min={min}
      disabled={disabled}
      value={t}
      onChange={(e) => setT(e.target.value)}
      onBlur={() => {
        const raw = t.trim();
        const next = raw ? Number(raw) : null;
        if (next != null && (Number.isNaN(next) || next < min)) return revert();
        if (next !== value) onSave(next);
      }}
    />
  );
}

function SubtasksSection({ task, disabled }: { task: Task; disabled?: boolean }) {
  const setSubtasks = useSetSubtasks();
  const [text, setText] = useState("");

  const rows = task.subtasks.map((s) => ({ text: s.text, done: s.done }));
  const apply = (next: { text: string; done: boolean }[]) =>
    setSubtasks.mutate({ id: task.id, subtasks: next });

  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-[.4px] text-muted-400">
        Checklist
      </div>
      {task.subtasks.map((s, i) => (
        <div key={s.id} className="flex items-center gap-2 py-0.5 text-[13px]">
          <input
            type="checkbox"
            checked={s.done}
            disabled={disabled || setSubtasks.isPending}
            onChange={(e) => apply(rows.map((r, j) => (j === i ? { ...r, done: e.target.checked } : r)))}
          />
          <span className={cn("min-w-0 flex-1 truncate", s.done && "text-faint line-through")}>
            {s.text}
          </span>
          {!disabled && (
            <button
              type="button"
              className="text-[13px] text-[#b6bcc5] hover:text-danger"
              onClick={() => apply(rows.filter((_, j) => j !== i))}
            >
              ×
            </button>
          )}
        </div>
      ))}
      {task.subtasks.length === 0 && disabled && (
        <p className="text-[12px] text-faint">No steps.</p>
      )}
      {!disabled && (
        <div className="mt-1 flex items-center gap-2">
          <Input
            className="flex-1"
            placeholder="Add a step…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && text.trim()) {
                apply([...rows, { text: text.trim(), done: false }]);
                setText("");
              }
            }}
          />
        </div>
      )}
    </div>
  );
}

/** Free-text notes on the task — anyone posts; delete your own (or admin). Read-only when locked. */
function CommentsSection({
  task,
  currentUserId,
  isAdmin,
  userName,
  disabled,
}: {
  task: Task;
  currentUserId?: string;
  isAdmin: boolean;
  userName: (id: string | null) => string;
  disabled?: boolean;
}) {
  const addComment = useAddComment();
  const removeComment = useDeleteComment();
  const [body, setBody] = useState("");

  const post = () => {
    const b = body.trim();
    if (!b) return;
    addComment.mutate({ id: task.id, body: b }, { onSuccess: () => setBody("") });
  };

  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-[.4px] text-muted-400">
        Comments{task.comments.length > 0 && ` · ${task.comments.length}`}
      </div>
      {task.comments.length === 0 && <p className="text-[12px] text-faint">No notes yet.</p>}
      <div className="space-y-2">
        {task.comments.map((c) => (
          <div key={c.id} className="rounded-(--radius-field) bg-[#f7f8fa] px-3 py-2 text-[13px]">
            <div className="mb-0.5 flex items-center gap-2 text-[11px] text-muted">
              <span className="font-medium text-ink-700">{userName(c.authorId)}</span>
              <span>
                {new Date(c.createdAt).toLocaleString("en-GB", {
                  day: "2-digit",
                  month: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              {!disabled && (isAdmin || c.authorId === currentUserId) && (
                <button
                  type="button"
                  className="ml-auto font-medium text-muted hover:text-danger hover:underline"
                  onClick={() => removeComment.mutate(c.id)}
                >
                  Delete
                </button>
              )}
            </div>
            <div className="whitespace-pre-wrap break-words text-ink-700">{c.body}</div>
          </div>
        ))}
      </div>
      {!disabled && (
        <div className="mt-2 space-y-1.5">
          <Textarea
            className="h-[52px]"
            placeholder="Add a note for yourself or the team…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="flex justify-end">
            <Button size="sm" disabled={!body.trim() || addComment.isPending} onClick={post}>
              Post note
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function TimeLog({
  task,
  isAdmin,
  userName,
}: {
  task: Task;
  isAdmin: boolean;
  userName: (id: string | null) => string;
}) {
  const removeEntry = useDeleteTimeEntry();
  const [editEntry, setEditEntry] = useState<TimeEntry | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-[.4px] text-muted-400">
          Time log · {fmtDuration(task.trackedSeconds)}
        </span>
        {isAdmin && (
          <button
            type="button"
            className="text-[12px] font-medium text-primary-link hover:underline"
            onClick={() => setAddOpen(true)}
          >
            + Add time
          </button>
        )}
      </div>
      {task.timeEntries.length === 0 && (
        <p className="text-[12px] text-faint">Nothing tracked yet.</p>
      )}
      {task.timeEntries.map((e) => (
        <div key={e.id} className="flex items-start gap-2 border-b border-divider py-1.5 text-[13px] last:border-0">
          <span className="font-medium">{userName(e.userId)}</span>
          {e.stoppedAt === null ? (
            <span className="animate-pulse text-[12px] font-semibold text-primary">running…</span>
          ) : (
            <span className="tabular-nums text-muted">{fmtDuration(e.seconds ?? 0)}</span>
          )}
          {e.source === "manual" && (
            <span className="rounded-[5px] bg-[#f6efdc] px-1.5 text-[11px] text-[#8b6a1f]">manual</span>
          )}
          <span className="min-w-0 flex-1 truncate text-muted" title={e.comment ?? ""}>
            {e.comment ?? ""}
          </span>
          {isAdmin && (
            <span className="flex gap-2">
              {e.stoppedAt !== null && (
                <button
                  type="button"
                  className="text-[12px] font-medium text-primary-link hover:underline"
                  onClick={() => setEditEntry(e)}
                >
                  Edit
                </button>
              )}
              <button
                type="button"
                className="text-[12px] font-medium text-muted hover:text-danger hover:underline"
                onClick={() => removeEntry.mutate(e.id)}
              >
                Delete
              </button>
            </span>
          )}
        </div>
      ))}
      {editEntry && <EditTimeModal entry={editEntry} onClose={() => setEditEntry(null)} />}
      {addOpen && <AddTimeModal taskId={task.id} onClose={() => setAddOpen(false)} />}
    </div>
  );
}

function EditTimeModal({ entry, onClose }: { entry: TimeEntry; onClose: () => void }) {
  const updateEntry = useUpdateTimeEntry();
  const [minutes, setMinutes] = useState(Math.max(1, Math.round((entry.seconds ?? 0) / 60)));
  const [comment, setComment] = useState(entry.comment ?? "");
  const serverError = updateEntry.error instanceof ApiError ? updateEntry.error.message : null;

  const save = async () => {
    try {
      await updateEntry.mutateAsync({
        entryId: entry.id,
        input: { minutes, comment: comment.trim() || undefined },
      });
      onClose();
    } catch {
      /* surfaced below */
    }
  };

  return (
    <Modal
      title="Edit time entry"
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={updateEntry.isPending} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-[13px]">
          <span>Duration</span>
          <Input
            className="w-20"
            type="number"
            min={1}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value) || 1)}
          />
          <span className="text-muted">minutes</span>
        </div>
        <div>
          <Label>Comment</Label>
          <Input value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
      </div>
    </Modal>
  );
}

function AddTimeModal({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { data: team } = useAssignees();
  const addEntry = useAddTimeEntry();
  const [userId, setUserId] = useState("");
  const [minutes, setMinutes] = useState(30);
  const [comment, setComment] = useState("");
  const [date, setDate] = useState(todayPlus(0));
  const serverError = addEntry.error instanceof ApiError ? addEntry.error.message : null;

  const save = async () => {
    if (!userId || !comment.trim()) return;
    try {
      await addEntry.mutateAsync({
        taskId,
        input: { userId, minutes, comment: comment.trim(), date },
      });
      onClose();
    } catch {
      /* surfaced below */
    }
  };

  return (
    <Modal
      title="Add time (admin)"
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!userId || !comment.trim() || addEntry.isPending} onClick={() => void save()}>
            Add
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <Label>Who worked</Label>
          <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">— pick —</option>
            {(team ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.firstName} {u.lastName}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex items-center gap-2 text-[13px]">
          <span>Duration</span>
          <Input
            className="w-20"
            type="number"
            min={1}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value) || 1)}
          />
          <span className="text-muted">min on</span>
          <Input className="w-36" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <Label>What was done</Label>
          <Input value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
      </div>
    </Modal>
  );
}

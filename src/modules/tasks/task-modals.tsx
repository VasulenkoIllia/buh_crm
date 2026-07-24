import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Task, TimeEntry } from "@shared/schema/task";
import { useAuth } from "@/app/auth";
import { ServiceChip, useCatalog } from "@/modules/catalog";
import { ClientFormModal, useClient, useClients } from "@/modules/clients";
import { LeadFormModal, useLeads } from "@/modules/leads";
import { useSettings } from "@/modules/settings";
import { ApiError } from "@/shared/lib/api";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input, Label, Select } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { Segmented } from "@/shared/ui/segmented";
import { TimerCommentModal, fmtDuration, useElapsed } from "./timer";
import {
  useActiveTimer,
  useAddTimeEntry,
  useArchiveTask,
  useAssignees,
  useCreateTask,
  useDeleteTimeEntry,
  useSetSubtasks,
  useStartTimer,
  useTaskColumns,
  useUpdateTask,
  useUpdateTimeEntry,
} from "./tasks.api";

const todayPlus = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

const pill = (selected: boolean) =>
  cn(
    "rounded-(--radius-chip) border px-2.5 py-1 text-[12px] font-medium",
    selected
      ? "border-primary bg-[#eef1fb] text-primary-link"
      : "border-border bg-surface text-muted hover:bg-divider",
  );

// ── create / edit ────────────────────────────────────────────────────────────

/** A resolved task target: a client (through one of its subscriptions) or a lead. */
export type Target =
  | { kind: "client"; id: string; label: string }
  | { kind: "lead"; id: string; label: string };

export function TaskFormModal({
  task,
  preset,
  onClose,
}: {
  task?: Task;
  /** pre-target a new task (from a client/lead card's "+ New task") */
  preset?: Target;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const { data: services } = useCatalog();
  const { data: settings } = useSettings();
  const { data: team } = useAssignees();
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
  const [deadline, setDeadline] = useState(task?.deadline ? task.deadline.slice(0, 10) : "");
  const [plannedMinutes, setPlannedMinutes] = useState<number | null>(task?.plannedMinutes ?? null);
  const [amount, setAmount] = useState<number | null>(task?.amount ?? null);
  const [description, setDescription] = useState(task?.description ?? "");
  // new task → the creator is the default assignee (removable); edit → keep current
  const [assignees, setAssignees] = useState<Set<string>>(
    () => new Set(task ? task.assignees : user ? [user.id] : []),
  );
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
        await create.mutateAsync({
          ...workflow,
          clientId: type === "client" && target?.kind === "client" ? target.id : null,
          leadId: type === "client" && target?.kind === "lead" ? target.id : null,
          subscriptionId:
            type === "client" && target?.kind === "client" ? subscriptionId || null : null,
          amount: isOneTimeJob ? amount : null,
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
          <p className="rounded-(--radius-field) bg-[#eef1fb] px-3 py-2 text-[12px] text-[#2f4fd6]">
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
                  <p className="rounded-(--radius-field) bg-[#fdf5f5] px-3 py-2 text-[12px] text-[#c23434]">
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
                  <button key={t.id} type="button" className={pill(false)} onClick={() => applyPreset(t.id)}>
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
          <p className="rounded-(--radius-field) bg-[#eef1fb] px-3 py-2 text-[12px] text-[#2f4fd6]">
            💰 Invoice {task!.invoice.number} · ${(task!.invoice.amount / 100).toFixed(2)} — price locked.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
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
          <div>
            <Label>Planned time (min)</Label>
            <Input
              type="number"
              min={1}
              value={plannedMinutes ?? ""}
              onChange={(e) => setPlannedMinutes(e.target.value ? Number(e.target.value) : null)}
            />
          </div>
        </div>

        <div>
          <Label>Deadline (optional)</Label>
          <div className="flex flex-wrap items-center gap-1.5">
            {[1, 2, 5].map((d) => (
              <button
                key={d}
                type="button"
                className={pill(deadline === todayPlus(d))}
                onClick={() => setDeadline(todayPlus(d))}
              >
                +{d} days
              </button>
            ))}
            <button type="button" className={pill(deadline === "")} onClick={() => setDeadline("")}>
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
          <div className="flex flex-wrap gap-1.5">
            {(team ?? [])
              .filter((u) => u.status === "active" || assignees.has(u.id))
              .map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className={pill(assignees.has(u.id))}
                  onClick={() => toggleAssignee(u.id)}
                >
                  {u.firstName} {u.lastName}
                  {u.status === "blocked" && " ⛔"}
                </button>
              ))}
          </div>
        </div>

        <div>
          <Label>Description</Label>
          <textarea
            className="h-[74px] w-full resize-none rounded-(--radius-field) border border-border px-3 py-2 text-[13px] outline-none focus:border-primary"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
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
  const [editOpen, setEditOpen] = useState(false);

  const isAdmin = user?.role === "admin";
  const client = clientsResp?.items.find((c) => c.id === task.clientId);
  const service = services?.find((s) => s.id === task.serviceId);
  const priority = settings?.priorities.find((p) => p.id === task.priorityId);
  const column = columns?.find((c) => c.id === task.statusColumnId);
  const userName = (id: string | null) => {
    const u = team?.find((x) => x.id === id);
    return u ? `${u.firstName} ${u.lastName}` : "—";
  };

  if (editOpen) {
    return <TaskFormModal task={task} onClose={() => setEditOpen(false)} />;
  }

  return (
    <Modal
      title={task.title}
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
          <Button variant="secondary" onClick={() => setEditOpen(true)}>
            Edit
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* status row */}
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-[13px] font-medium">
            <input
              type="checkbox"
              checked={task.done}
              disabled={update.isPending}
              onChange={(e) =>
                update.mutate({ id: task.id, input: { done: e.target.checked } })
              }
            />
            Done
          </label>
          <span className="rounded-[5px] bg-[#eef0f3] px-2 py-[2px] text-[11px] capitalize text-ink-700">
            {column?.name ?? "—"}
          </span>
          {priority && (
            <span
              className="rounded-[5px] px-2 py-[2px] text-[11px] font-semibold"
              style={{ color: priority.color, backgroundColor: `${priority.color}1a` }}
            >
              {priority.name}
            </span>
          )}
          {task.kind === "sub" && (
            <span className="rounded-[5px] bg-[#eef1fb] px-2 py-[2px] text-[11px] text-[#2f4fd6]">
              📅 auto · {task.periodKey}
            </span>
          )}
          {task.kind === "free" && !task.clientId && (
            <span className="rounded-[5px] bg-[#f6efdc] px-2 py-[2px] text-[11px] text-[#8b6a1f]">
              internal
            </span>
          )}
          {task.kind === "free" && task.clientId && (
            <span className="rounded-[5px] bg-[#e2f4f0] px-2 py-[2px] text-[11px] text-[#0e7a6b]">
              included in the plan
            </span>
          )}
        </div>

        {/* meta grid */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 text-[13px]">
          <MetaField label="Client">
            {client ? (
              <Link to={`/clients/${client.id}`} className="text-primary-link hover:underline">
                {client.displayName}
              </Link>
            ) : (
              "—"
            )}
          </MetaField>
          <MetaField label="Service">
            {service ? <ServiceChip name={service.name} color={service.color} /> : "—"}
          </MetaField>
          <MetaField label="Deadline">
            {task.deadline ? new Date(task.deadline).toLocaleDateString("en-GB") : "—"}
          </MetaField>
          <MetaField label="Planned / tracked">
            {task.plannedMinutes != null ? `${task.plannedMinutes} min` : "—"} ·{" "}
            {fmtDuration(task.trackedSeconds)}
          </MetaField>
          {task.amount != null && (
            <MetaField label="Job price">${(task.amount / 100).toFixed(2)}</MetaField>
          )}
          {task.invoice && (
            <MetaField label="Invoice">
              <span className="font-medium text-[#2f4fd6]">💰 {task.invoice.number}</span> · $
              {(task.invoice.amount / 100).toFixed(2)}
              {task.invoice.dueDate &&
                ` · due ${new Date(task.invoice.dueDate).toLocaleDateString("en-GB")}`}
            </MetaField>
          )}
          <MetaField label="Assignees">
            {task.assignees.length === 0 ? "unassigned" : task.assignees.map(userName).join(", ")}
          </MetaField>
          {task.description && (
            <div className="col-span-2">
              <MetaField label="Description">
                <span className="whitespace-pre-wrap">{task.description}</span>
              </MetaField>
            </div>
          )}
        </div>

        <TimerControls task={task} />
        <SubtasksSection task={task} />
        <TimeLog task={task} isAdmin={isAdmin} userName={userName} />
      </div>
    </Modal>
  );
}

function MetaField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-[3px] text-[11px] uppercase tracking-[.4px] text-muted-400">{label}</div>
      <div className="text-ink-700">{children}</div>
    </div>
  );
}

/** Start/stop on THIS task, honoring the one-timer-per-user rule. */
function TimerControls({ task }: { task: Task }) {
  const { data: timer } = useActiveTimer();
  const start = useStartTimer();
  const [modal, setModal] = useState<"stop" | "switch" | null>(null);
  const mine = timer?.taskId === task.id;
  const elapsed = useElapsed(mine ? timer?.startedAt : undefined);

  return (
    <div className="flex items-center gap-3 rounded-(--radius-field) bg-[#f7f8fa] px-3 py-2.5">
      {mine ? (
        <>
          <span className="animate-pulse text-[13px] font-bold text-[#3355dd]">
            ⏱ {fmtDuration(elapsed)}
          </span>
          <Button size="sm" variant="secondary" onClick={() => setModal("stop")}>
            Stop
          </Button>
        </>
      ) : (
        <>
          <span className="text-[13px] text-muted">
            {timer ? `Timer runs on “${timer.taskTitle}”` : "No timer running"}
          </span>
          <Button
            size="sm"
            onClick={() => {
              if (timer) setModal("switch"); // close the old interval with a comment first
              else start.mutate({ taskId: task.id });
            }}
          >
            ▶ Start
          </Button>
        </>
      )}
      {modal && timer && (
        <TimerCommentModal
          timer={timer}
          next={modal === "switch" ? { taskId: task.id, title: task.title } : undefined}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

function SubtasksSection({ task }: { task: Task }) {
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
            disabled={setSubtasks.isPending}
            onChange={(e) => apply(rows.map((r, j) => (j === i ? { ...r, done: e.target.checked } : r)))}
          />
          <span className={cn("min-w-0 flex-1 truncate", s.done && "text-faint line-through")}>
            {s.text}
          </span>
          <button
            type="button"
            className="text-[13px] text-[#b6bcc5] hover:text-danger"
            onClick={() => apply(rows.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
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
            <span className="animate-pulse text-[12px] font-semibold text-[#3355dd]">running…</span>
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

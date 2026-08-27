import { useState } from "react";
import { Pencil, RotateCcw, Star } from "lucide-react";
import type { Client, Subscription } from "@shared/schema/client";
import { billsPerJob, isClientFacing } from "@shared/schema/catalog";
import type { Service, TaskOverride, TaskTemplate } from "@shared/schema/catalog";
import type { BillingPeriod } from "@shared/schema/enums";
import {
  ServiceChip,
  TaskRhythmFields,
  rhythmSummary,
  useCatalog,
  type RhythmValue,
} from "@/modules/catalog";
import { ApiError } from "@/shared/lib/api";
import { cn } from "@/shared/lib/cn";
import { fmtBizDate, todayIso } from "@/shared/lib/format";
import { fmtMoney } from "@/shared/lib/money";
import { Button, IconButton } from "@/shared/ui/button";
import { PERIOD_LABEL } from "./recurring";
import { Chip } from "@/shared/ui/chip";
import { ChecklistEditor } from "@/shared/ui/checklist-editor";
import { FormField, Input, Label, Select } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { InfoHint } from "@/shared/ui/info-hint";
import { ScrollBox } from "@/shared/ui/scroll-box";
import { pillCls } from "@/shared/ui/pill";
import {
  useAddSubscription,
  usePauseSubscription,
  useResumeSubscription,
  useUpdateSubscription,
} from "./clients.api";

/** Effective per-client config for a service task = template + the fields the override sets. */
interface EffectiveTask extends RhythmValue {
  enabled: boolean;
}
const pick = <T,>(override: T | undefined, template: T): T =>
  override !== undefined ? override : template;
function effectiveTask(template: TaskTemplate, override?: TaskOverride): EffectiveTask {
  return {
    enabled: override?.enabled ?? true,
    periodicity: pick(override?.periodicity, template.periodicity),
    dayOfPeriod: pick(override?.dayOfPeriod, template.dayOfPeriod),
    monthOfPeriod: pick(override?.monthOfPeriod, template.monthOfPeriod),
    deadlineOffsetDays: pick(override?.deadlineOffsetDays, template.deadlineOffsetDays),
    estimatedMinutes: pick(override?.estimatedMinutes, template.estimatedMinutes),
  };
}

/** True when the override customizes anything beyond the include flag (rhythm/planned/checklist). */
const rhythmEdited = (o?: TaskOverride) =>
  !!o &&
  (o.periodicity !== undefined ||
    o.deadlineOffsetDays !== undefined ||
    o.estimatedMinutes !== undefined ||
    o.checklist !== undefined);

type BillingTiming = { trigger: "on_period_start" | "on_period_end"; day: number | null };

/** The service preset, normalized to a subscription-shaped timing. */
function presetTiming(service?: Service): BillingTiming {
  if (!service || service.invoiceTrigger !== "on_period_end") {
    return {
      trigger: "on_period_start",
      day: service?.invoiceTrigger === "on_period_start" ? (service.invoiceDay ?? null) : null,
    };
  }
  return { trigger: "on_period_end", day: null };
}

/** What actually applies to this subscription (its own value, else the preset). */
function effectiveTiming(sub: Subscription, service?: Service): BillingTiming {
  if (sub.invoiceTrigger === "on_period_end") return { trigger: "on_period_end", day: null };
  if (sub.invoiceTrigger === "on_period_start")
    return { trigger: "on_period_start", day: sub.invoiceDay ?? null };
  return presetTiming(service);
}

const timingLabel = (t: BillingTiming) =>
  t.trigger === "on_period_end"
    ? "end of period"
    : t.day != null
      ? `day ${t.day}`
      : "start of period";

/** Start / End / Custom-day pills — the same rule editor for add + edit. */
function BillingPills({
  value,
  onChange,
}: {
  value: BillingTiming;
  onChange: (v: BillingTiming) => void;
}) {
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          className={pillCls(value.trigger === "on_period_start" && value.day == null)}
          onClick={() => onChange({ trigger: "on_period_start", day: null })}
        >
          Start of period
        </button>
        <button
          type="button"
          className={pillCls(value.trigger === "on_period_end")}
          onClick={() => onChange({ trigger: "on_period_end", day: null })}
        >
          End of period
        </button>
        <button
          type="button"
          className={pillCls(value.trigger === "on_period_start" && value.day != null)}
          onClick={() => onChange({ trigger: "on_period_start", day: 5 })}
        >
          Custom day
        </button>
        {value.trigger === "on_period_start" && value.day != null && (
          <Input
            className="w-14"
            type="number"
            min={1}
            max={31}
            value={value.day}
            onChange={(e) =>
              onChange({
                trigger: "on_period_start",
                day: e.target.value ? Number(e.target.value) : 1,
              })
            }
          />
        )}
      </div>
    </div>
  );
}

function DueDaysField({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  // subscription-level: null inherits the service preset (the preset itself may be "never")
  return (
    /* One flex row with no wrap squeezed three items into a 500px modal: the label broke across
       two lines around the input and the trailing text was cut off mid-word (user, 2026-08-27).
       Wrapping, with each phrase kept whole, drops cleanly onto a second line instead. */
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
      <span className="whitespace-nowrap">Invoice overdue after</span>
      <Input
        className="w-16"
        type="number"
        min={1}
        max={365}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      />
      {/* the "empty means" half is a RULE and stays on the surface — it is what the empty field
          you are looking at actually does */}
      <span className="whitespace-nowrap text-muted">days — empty = the service&apos;s own setting</span>
    </div>
  );
}

/** Subscription table inside the client card's Regular section. */
export function SubscriptionList({ client }: { client: Client }) {
  const { data: services } = useCatalog();
  const update = useUpdateSubscription();
  const [editing, setEditing] = useState<Subscription | undefined>();
  const [serving, setServing] = useState<Subscription | undefined>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const byId = new Map((services ?? []).map((s) => [s.id, s]));

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (client.subscriptions.length === 0) {
    return (
      <p className="text-[13px] text-muted">
        No subscriptions yet — add a service from the catalog below.
      </p>
    );
  }

  const serverError = update.error instanceof ApiError ? update.error.message : null;

  return (
    <div>
      {client.subscriptions.map((sub) => {
        const service = byId.get(sub.serviceId);
        const company = sub.companyId
          ? client.companies.find((c) => c.id === sub.companyId)?.name
          : null;
        const taskCount = service?.taskTemplates.length ?? 0;
        // mirrors the server guard: the default service may not be STOPPED, but it may be resumed,
        // and an end date already on it may be moved or called off
        const cannotPause = sub.isDefault && sub.state === "in_force" && !sub.inForceUntil;
        return (
          <div key={sub.id} className={cn(sub.state !== "in_force" && "opacity-50")}>
            <div className="flex items-center gap-3 border-b border-divider py-2 text-[13px]">
              {taskCount > 0 ? (
                <button
                  type="button"
                  aria-label="Toggle tasks"
                  className={cn(
                    "text-[11px] text-muted transition-transform",
                    expanded.has(sub.id) && "rotate-90",
                  )}
                  onClick={() => toggle(sub.id)}
                >
                  ▸
                </button>
              ) : (
                <span className="w-[11px]" />
              )}
              {service ? (
                <ServiceChip name={service.name} color={service.color} />
              ) : (
                <span className="text-muted">unknown service</span>
              )}
              {taskCount > 0 && (
                <span className="text-[12px] text-[#9aa1ab]">· {taskCount} tasks</span>
              )}
              {company && <span className="text-[12px] text-muted">({company})</span>}
              {/* three states, not two: a subscription can also be agreed for a FUTURE date, and
                  an in-force one can carry an end date that was set in advance */}
              {sub.state === "scheduled" && (
                <Chip tone="amber" title="Agreed in advance — service has not started yet">
                  from {fmtBizDate(sub.inForceFrom)}
                </Chip>
              )}
              {sub.state === "paused" && (
                <Chip tone="gray" title="Not being served">
                  paused{sub.inForceUntil ? ` since ${fmtBizDate(sub.inForceUntil)}` : ""}
                </Chip>
              )}
              {sub.state === "in_force" && sub.inForceUntil && (
                <Chip tone="amber" title="An end date was set — it stops being served after this">
                  until {fmtBizDate(sub.inForceUntil)}
                </Chip>
              )}
              {sub.isDefault && (
                <Chip
                  tone="blue"
                  strong
                  title="The client's default service — it prefills their service pickers"
                >
                  ★ default
                </Chip>
              )}
              <span className="ml-auto tabular-nums">{fmtMoney(sub.amount)}</span>
              <span className="text-[12px] text-muted">
                {/* a one-time service has no period at all — `sub.period` is null there */}
                {sub.period === null
                  ? "per job" // container for manual jobs — period/billing don't apply
                  : `${PERIOD_LABEL[sub.period]} · ${timingLabel(effectiveTiming(sub, service))}`}
              </span>
              {/* same quiet icon strip as the Service catalog rows — one look for row actions */}
              <IconButton label="Edit service" onClick={() => setEditing(sub)}>
                <Pencil size={15} />
              </IconButton>
              {/* mirrors the server: a service that hasn't STOPPED may be the default — including
                  one agreed for a future date, which is still the client's service. It has to be
                  cleared before the service can be paused, so the two controls sit together. */}
              {sub.state !== "paused" && (
                <IconButton
                  label={
                    sub.isDefault
                      ? "The client's default service — click to clear"
                      : "Make this the client's default service"
                  }
                  disabled={update.isPending}
                  className={cn(sub.isDefault && "text-[#2f4fd6] hover:text-[#2f4fd6]")}
                  onClick={() =>
                    update
                      .mutateAsync({
                        clientId: client.id,
                        subscriptionId: sub.id,
                        input: { isDefault: !sub.isDefault },
                      })
                      .catch(() => {})
                  }
                >
                  <Star size={15} fill={sub.isDefault ? "currentColor" : "none"} />
                </IconButton>
              )}
              {/* pausing and resuming ask for a DATE — that date is what the whole billing and
                  generation model reads later, so it can't be a bare toggle.
                  The default service can't be stopped, and the tooltip said so while the button
                  still opened a dialog that could only 409 — so it is DISABLED instead. Resuming,
                  and calling off an end date that is already scheduled, stay open: neither takes
                  the service away from the pickers (2026-07-30 audit). */}
              <Button
                variant="secondary"
                size="sm"
                disabled={cannotPause}
                title={
                  cannotPause
                    ? "Clear the default first — it prefills this client's service pickers"
                    : undefined
                }
                onClick={() => setServing(sub)}
              >
                {sub.state === "paused"
                  ? "Resume"
                  : sub.inForceUntil
                    ? "End date" // already scheduled to stop: move it, or call it off
                    : "Pause"}
              </Button>
            </div>
            {expanded.has(sub.id) && service && (
              <SubscriptionTasks client={client} sub={sub} service={service} />
            )}
          </div>
        );
      })}
      {serverError && <p className="mt-1 text-[12px] text-danger-text">{serverError}</p>}
      {editing && (
        <EditSubscriptionModal
          client={client}
          sub={editing}
          service={byId.get(editing.serviceId)}
          open
          onClose={() => setEditing(undefined)}
        />
      )}
      {serving && (
        <ServingModal client={client} sub={serving} onClose={() => setServing(undefined)} />
      )}
    </div>
  );
}

/**
 * Pause or resume a service, with the date that decides everything downstream.
 *
 * Pausing "on the 20th" means the 20th is still served — the app stores the exclusive day behind
 * the scenes and never shows it. The dialog also says what pausing does NOT do: an invoice that
 * has already gone out stays out, and tasks already on the board stay there.
 */
function ServingModal({
  client,
  sub,
  onClose,
}: {
  client: Client;
  sub: Subscription;
  onClose: () => void;
}) {
  const pause = usePauseSubscription();
  const resume = useResumeSubscription();
  const resuming = sub.state === "paused";
  // already stopping on a known day: this dialog moves that day or removes it altogether
  const scheduled = !resuming && !!sub.inForceUntil;
  const [date, setDate] = useState(scheduled ? sub.inForceUntil! : todayIso());
  const [note, setNote] = useState("");
  const mutation = resuming ? resume : pause;
  const serverError = mutation.error instanceof ApiError ? mutation.error.message : null;

  const save = async () => {
    const payload = { clientId: client.id, subscriptionId: sub.id };
    try {
      if (resuming) {
        await resume.mutateAsync({
          ...payload,
          // same reason as the start date above: an untouched "today" is the server's to resolve
          input: { startsOn: date === todayIso() ? undefined : date, note: note.trim() || undefined },
        });
      } else {
        await pause.mutateAsync({ ...payload, input: { lastDay: date, note: note.trim() || undefined } });
      }
      onClose();
    } catch {
      /* surfaced via serverError below */
    }
  };

  /** Call off a planned stop: `lastDay: null` puts the service back to open-ended. */
  const removeEndDate = async () => {
    try {
      await pause.mutateAsync({ ...payload(), input: { lastDay: null } });
      onClose();
    } catch {
      /* surfaced via serverError below */
    }
  };
  function payload() {
    return { clientId: client.id, subscriptionId: sub.id };
  }

  return (
    <Modal
      title={resuming ? "Resume service" : scheduled ? "Change the end date" : "Pause service"}
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {scheduled && (
            <Button
              variant="secondary"
              disabled={mutation.isPending}
              onClick={() => void removeEndDate()}
            >
              Remove end date
            </Button>
          )}
          <Button onClick={() => void save()} disabled={!date || mutation.isPending}>
            {mutation.isPending ? "Saving…" : resuming ? "Resume" : scheduled ? "Save" : "Pause"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField
          label={resuming ? "Served again from" : "Last day served (inclusive)"}
          htmlFor="serving-date"
        >
          <Input
            id="serving-date"
            type="date"
            autoFocus
            // resuming can't reach backwards (same rule as a new service); PAUSING still can —
            // recording that service stopped earlier only ever REMOVES coverage, never invents it
            min={resuming ? todayIso() : undefined}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </FormField>
        <FormField label="Note (optional)" htmlFor="serving-note">
          <Input
            id="serving-note"
            placeholder={resuming ? "e.g. back after the summer" : "e.g. paused at the client's request"}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </FormField>
        <p className="text-[12px] text-muted">
          {resuming
            ? "A period covered only in part is never invoiced automatically — you'll get a reminder task to issue that one by hand."
            : "Work already on the board and invoices already issued are not touched. A period served only in part raises a reminder to invoice it by hand."}
        </p>
        <p className="text-[12px] text-muted">
          A date in the future is fine — the change simply takes effect then.
        </p>
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
      </div>
    </Modal>
  );
}

/** The service's tasks, tuned per THIS client (rhythm / planned time / include). */
function SubscriptionTasks({
  client,
  sub,
  service,
}: {
  client: Client;
  sub: Subscription;
  service: Service;
}) {
  const update = useUpdateSubscription();
  const [editing, setEditing] = useState<TaskTemplate | undefined>();
  const overrides = sub.rhythmOverrides ?? {};

  const patch = (next: Record<string, TaskOverride>) =>
    update
      .mutateAsync({ clientId: client.id, subscriptionId: sub.id, input: { rhythmOverrides: next } })
      .catch(() => {});

  const setOverride = (templateId: string, value: TaskOverride | null) => {
    const next = { ...overrides };
    if (value === null) delete next[templateId];
    else next[templateId] = value;
    void patch(next);
  };

  const serverError = update.error instanceof ApiError ? update.error.message : null;

  return (
    <div className="border-b border-divider bg-[#fafbfc] px-4 py-2 pl-9">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[.4px] text-muted-400">
        Tasks for this client
        <InfoHint label="Where these tasks come from">
          Defaults come from the service — tune rhythm, planned time or drop a task for this
          client. Tasks are generated per rhythm with the Tasks stage (S6).
        </InfoHint>
      </div>
      {service.taskTemplates.map((t) => {
        const ov = overrides[t.id];
        const eff = effectiveTask(t, ov);
        return (
          <div key={t.id} className="flex items-center gap-2 py-1 text-[13px]">
            <input
              type="checkbox"
              checked={eff.enabled}
              aria-label={`Include ${t.name}`}
              disabled={update.isPending} // serialize map writes — a stale base would drop edits
              onChange={() => {
                if (eff.enabled) {
                  // exclude: keep rhythm edits if any; a bare flag keeps following the template
                  setOverride(t.id, ov ? { ...ov, enabled: false } : { enabled: false });
                } else {
                  // include again: a flag-only entry just disappears (back to pure template)
                  setOverride(t.id, rhythmEdited(ov) ? { ...ov, enabled: true } : null);
                }
              }}
            />
            <span className={cn("min-w-0 truncate", !eff.enabled && "text-faint line-through")}>
              {t.name}
            </span>
            <span className="ml-auto text-[12px] text-[#6b7280]">{rhythmSummary(eff)}</span>
            {rhythmEdited(ov) && (
              <span className="text-[11px] font-medium text-[#b5651d]">edited</span>
            )}
            <IconButton label="Edit this client's rhythm" onClick={() => setEditing(t)}>
              <Pencil size={14} />
            </IconButton>
            {ov && (
              <IconButton
                label="Reset to the service default"
                disabled={update.isPending}
                onClick={() => setOverride(t.id, null)}
              >
                <RotateCcw size={14} />
              </IconButton>
            )}
          </div>
        );
      })}
      {serverError && <p className="mt-1 text-[12px] text-danger-text">{serverError}</p>}
      {editing && (
        <TaskOverrideModal
          template={editing}
          effective={effectiveTask(editing, overrides[editing.id])}
          override={overrides[editing.id]}
          oneTime={billsPerJob(service)}
          onApply={(value) => setOverride(editing.id, value)}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}

function TaskOverrideModal({
  template,
  effective,
  override,
  oneTime,
  onApply,
  onClose,
}: {
  template: TaskTemplate;
  effective: EffectiveTask;
  override?: TaskOverride;
  oneTime?: boolean;
  onApply: (value: TaskOverride | null) => void;
  onClose: () => void;
}) {
  const [enabled, setEnabled] = useState(effective.enabled);
  const [rhythm, setRhythm] = useState<RhythmValue>({
    periodicity: effective.periodicity,
    dayOfPeriod: effective.dayOfPeriod,
    monthOfPeriod: effective.monthOfPeriod,
    deadlineOffsetDays: effective.deadlineOffsetDays,
    estimatedMinutes: effective.estimatedMinutes,
  });
  // checklist: inherit (follow template) | custom (own list) | none (removed for this client)
  const initialMode: "inherit" | "custom" | "none" =
    override?.checklist === undefined ? "inherit" : override.checklist === null ? "none" : "custom";
  const [clMode, setClMode] = useState(initialMode);
  const [clSteps, setClSteps] = useState<string[]>(override?.checklist ?? template.defaultChecklist);

  /** Store ONLY what differs from the template — untouched fields keep tracking catalog edits. */
  const buildOverride = (): TaskOverride | null => {
    const o: TaskOverride = { enabled };
    if (
      rhythm.periodicity !== template.periodicity ||
      rhythm.dayOfPeriod !== template.dayOfPeriod ||
      rhythm.monthOfPeriod !== template.monthOfPeriod
    ) {
      // rhythm travels as one group — a bare day against a changed template is meaningless
      o.periodicity = rhythm.periodicity;
      o.dayOfPeriod = rhythm.dayOfPeriod;
      o.monthOfPeriod = rhythm.monthOfPeriod;
    }
    if (rhythm.deadlineOffsetDays !== template.deadlineOffsetDays) {
      o.deadlineOffsetDays = rhythm.deadlineOffsetDays;
    }
    if (rhythm.estimatedMinutes !== template.estimatedMinutes) {
      o.estimatedMinutes = rhythm.estimatedMinutes;
    }
    // inherit = leave absent; none = null; custom = the edited (trimmed) list
    if (clMode === "none") o.checklist = null;
    else if (clMode === "custom") o.checklist = clSteps.map((s) => s.trim()).filter(Boolean);
    return enabled && !rhythmEdited(o) ? null : o; // nothing changed → no override at all
  };

  return (
    <Modal
      title={`Task for this client — ${template.name}`}
      open
      onClose={onClose}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              onApply(null); // reset to the service default
              onClose();
            }}
          >
            Reset to default
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onApply(buildOverride());
              onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <label className="flex cursor-pointer items-center gap-2 text-[13px]">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Include this task for this client
        </label>
        <TaskRhythmFields
          value={rhythm}
          onChange={(p) => setRhythm((r) => ({ ...r, ...p }))}
          plannedHint="planned time for this client"
          oneTime={oneTime}
        />

        <div>
          <div className="mb-1.5 block text-[12px] font-medium text-ink-700">Checklist</div>
          <div className="flex flex-wrap gap-1.5">
            {(["inherit", "custom", "none"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  // switching to custom starts from whatever it currently inherits/had
                  if (m === "custom" && clSteps.length === 0) setClSteps([...template.defaultChecklist]);
                  setClMode(m);
                }}
                className={pillCls(clMode === m)}
              >
                {m === "inherit" ? "Inherit default" : m === "custom" ? "Custom" : "None"}
              </button>
            ))}
          </div>
          {clMode === "inherit" && (
            <p className="mt-1.5 text-[12px] text-muted">
              {template.defaultChecklist.length
                ? `Uses the service default (${template.defaultChecklist.length} step${template.defaultChecklist.length === 1 ? "" : "s"}).`
                : "The service has no default checklist."}
            </p>
          )}
          {clMode === "none" && (
            <p className="mt-1.5 text-[12px] text-muted">No checklist for this client's tasks.</p>
          )}
          {clMode === "custom" && (
            <div className="mt-1.5">
              <ChecklistEditor value={clSteps} onChange={setClSteps} />
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Per-client settings of an existing subscription: price, period, billing timing. */
function EditSubscriptionModal({
  client,
  sub,
  service,
  open,
  onClose,
}: {
  client: Client;
  sub: Subscription;
  service?: Service;
  open: boolean;
  onClose: () => void;
}) {
  const update = useUpdateSubscription();
  const [amount, setAmount] = useState<number | null>(sub.amount);
  // one-time subscriptions carry no period; the control is hidden for them, and what it holds is
  // never sent — the server derives the stored value from the service's type either way
  const [period, setPeriod] = useState<BillingPeriod>(sub.period ?? "month");
  const [companyId, setCompanyId] = useState(sub.companyId ?? "");
  const [timing, setTiming] = useState<BillingTiming>(() => effectiveTiming(sub, service));
  const [dueDays, setDueDays] = useState<number | null>(
    sub.dueDays ?? service?.dueDays ?? null,
  );
  const isOneTime = service ? billsPerJob(service) : false;

  const save = async () => {
    if (amount == null) return;
    try {
      await update.mutateAsync({
        clientId: client.id,
        subscriptionId: sub.id,
        input: {
          amount,
          period,
          companyId: companyId || null,
          invoiceTrigger: isOneTime ? null : timing.trigger,
          invoiceDay: isOneTime ? null : timing.day,
          dueDays,
        },
      });
      onClose();
    } catch {
      /* surfaced via serverError below */
    }
  };

  const serverError = update.error instanceof ApiError ? update.error.message : null;

  return (
    <Modal
      title={service ? `Subscription — ${service.name}` : "Subscription"}
      open={open}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={amount == null || update.isPending} onClick={() => void save()}>
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <Label>{isOneTime ? "Default job price for this client" : "Price for this client"}</Label>
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
            {!isOneTime && (
              <Select
                className="w-32"
                value={period}
                onChange={(e) => setPeriod(e.target.value as BillingPeriod)}
              >
                <option value="month">per month</option>
                <option value="quarter">per quarter</option>
                <option value="year">per year</option>
              </Select>
            )}
            {client.companies.length > 0 && (
              <Select
                className="flex-1"
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
              >
                <option value="">Client (main)</option>
                {client.companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </div>
        {!isOneTime && (
          <div>
            <Label>Invoice — when in the period</Label>
            <BillingPills value={timing} onChange={setTiming} />
          </div>
        )}
        <DueDaysField value={dueDays} onChange={setDueDays} />
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
      </div>
    </Modal>
  );
}

/** "Add service to client" — catalog list + per-client price (design: width 500). */
export function AddServiceModal({
  client,
  open,
  onClose,
}: {
  client: Client;
  open: boolean;
  onClose: () => void;
}) {
  const { data: services } = useCatalog();
  const add = useAddSubscription();
  const [serviceId, setServiceId] = useState("");
  const [amount, setAmount] = useState<number | null>(null);
  const [period, setPeriod] = useState<BillingPeriod>("month");
  const [timing, setTiming] = useState<BillingTiming>({ trigger: "on_period_start", day: null });
  const [startsOn, setStartsOn] = useState(todayIso());
  const [dueDays, setDueDays] = useState<number | null>(null);
  const [companyId, setCompanyId] = useState("");
  const [query, setQuery] = useState("");

  const active = (services ?? []).filter((s) => s.active && isClientFacing(s));
  const selected = active.find((s) => s.id === serviceId);

  /**
   * The filter appears exactly when the list stops fitting.
   *
   * The box is `max-h-56` and a row is about 37px, so beyond six the reader is scrolling to find
   * something — which is the moment a search earns its row of space, and before which it is
   * clutter over a list you can already see whole (the firm's catalog runs to twenty).
   */
  const VISIBLE_ROWS = 6;
  const searchable = active.length > VISIBLE_ROWS;
  const q = query.trim().toLowerCase();
  const shown = active.filter(
    // the PICKED service always stays on screen, however the query narrows: the panel below names
    // a price but never the service, so filtering the selection away would leave nothing saying
    // what is about to be added
    (s) => !q || s.id === serviceId || s.name.toLowerCase().includes(q),
  );
  // one-time service = container for manual jobs: no billing period, bills per job
  const isOneTime = selected ? billsPerJob(selected) : false;

  const pick = (id: string) => {
    setServiceId(id);
    const svc = active.find((s) => s.id === id);
    setAmount(svc?.defaultAmount ?? null); // expected price prefills, editable per client
    setTiming(presetTiming(svc)); // billing preset copies in, editable per client
    setDueDays(svc?.dueDays ?? null); // overdue preset copies in, editable per client
  };

  const save = async () => {
    if (!serviceId || amount == null) return;
    try {
      await add.mutateAsync({
        clientId: client.id,
        input: {
          serviceId,
          amount,
          // omitted for a one-time service, which has no period; the server derives it from the
          // service's type regardless of what is sent
          period: isOneTime ? undefined : period,
          companyId: companyId || null,
          invoiceTrigger: isOneTime ? null : timing.trigger,
          invoiceDay: isOneTime ? null : timing.day,
          dueDays,
          // untouched default → let the SERVER decide "today". It owns the firm timezone; the
          // viewer's calendar day can sit one behind it in the evening, and the no-backdating
          // guard would then refuse a perfectly ordinary "starts today" (2026-08-01)
          startsOn: startsOn === todayIso() ? undefined : startsOn,
        },
      });
      onClose();
    } catch {
      /* surfaced via serverError below */
    }
  };

  const serverError = add.error instanceof ApiError ? add.error.message : null;

  return (
    <Modal
      title="Add service to client"
      open={open}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!serviceId || amount == null || add.isPending} onClick={() => void save()}>
            {add.isPending ? "Adding…" : "Add to client"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {/* The date and the service filter share a row: one is narrow by nature and left a hand's
            width of nothing beside it, and the two together are simply "what, and from when". */}
        <div className="flex items-end gap-3">
          <FormField label="Service starts on" htmlFor="sub-starts">
            {/* today or later — the server refuses a backdated start, so the picker shouldn't
                offer one either (user, 2026-08-01) */}
            <Input
              id="sub-starts"
              type="date"
              className="w-40"
              min={todayIso()}
              value={startsOn}
              onChange={(e) => setStartsOn(e.target.value)}
            />
          </FormField>
          {searchable && (
            <div className="min-w-0 flex-1">
              <Label htmlFor="sub-search">Service</Label>
              <Input
                id="sub-search"
                type="search"
                placeholder="🔍 Search the catalog…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          )}
        </div>
        {/* Three rules, and all three are worth knowing before you agree a service — but as a
            four-line paragraph they were the biggest thing in the form. Same words, quieter. */}
        <p className="-mt-1 text-[11px] leading-snug text-faint">
          Today or a future date — a service is never agreed backwards; work already done is billed
          with a one-off invoice. No end date either: it runs until someone pauses it. A period
          served only in part isn&apos;t invoiced automatically — you&apos;ll get a reminder task to
          issue that one by hand.
        </p>
        {/* `stable` exactly when the filter is there: without it every keystroke resized the box
            and the price panel below jumped up and down while you were still typing */}
        <ScrollBox height={224} stable={searchable}>
          {active.length === 0 && (
            <p className="px-3 py-4 text-[13px] text-muted">
              The catalog is empty — create services on the Services page first.
            </p>
          )}
          {active.length > 0 && shown.length === 0 && (
            <p className="px-3 py-4 text-[13px] text-muted">
              No service matches “{query.trim()}”.
            </p>
          )}
          {shown.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => pick(s.id)}
              className={cn(
                "flex w-full items-center gap-2 border-b border-divider px-3 py-1.5 text-left text-[13px] last:border-0 hover:bg-divider/40",
                serviceId === s.id && "bg-[#eef1fb]",
              )}
            >
              <ServiceChip name={s.name} color={s.color} />
              <span className="text-[12px] text-muted">
                {s.type === "subscription" ? "Subscription" : "One-time"}
              </span>
              <span className="ml-auto text-[12px] text-muted">
                {s.defaultAmount != null ? `${fmtMoney(s.defaultAmount)} expected` : "—"}
              </span>
            </button>
          ))}
        </ScrollBox>

        {selected && (
          <div className="rounded-(--radius-field) bg-[#f7f8fa] p-2.5">
            <Label>
              {isOneTime ? "Default job price for this client" : "Price for this client"}{" "}
              {/* reference: what this price DOES. The rules above it stay on the page. */}
              <InfoHint label="How this price is used">
                {isOneTime
                  ? "A one-time service is a container for manual jobs. This price only prefills each new task — the actual price is set on the task itself (Tasks, S6)."
                  : "Prefilled from the catalog presets — adjust everything for this client."}
              </InfoHint>
            </Label>
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
              {!isOneTime && (
                <Select
                  className="w-32"
                  value={period}
                  onChange={(e) => setPeriod(e.target.value as BillingPeriod)}
                >
                  <option value="month">per month</option>
                  <option value="quarter">per quarter</option>
                  <option value="year">per year</option>
                </Select>
              )}
              {client.companies.length > 0 && (
                <Select
                  className="flex-1"
                  value={companyId}
                  onChange={(e) => setCompanyId(e.target.value)}
                >
                  <option value="">Client (main)</option>
                  {client.companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            {!isOneTime && (
              <div className="mt-2.5">
                <Label>Invoice — when in the period</Label>
                <BillingPills value={timing} onChange={setTiming} />
              </div>
            )}
            <div className="mt-2.5">
              <DueDaysField value={dueDays} onChange={setDueDays} />
            </div>
          </div>
        )}
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
      </div>
    </Modal>
  );
}

/** Category chip picker — full replace of the client's chip set. */

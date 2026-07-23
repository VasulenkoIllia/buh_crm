import { useState } from "react";
import type { Client, Subscription } from "@shared/schema/client";
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
import { Button } from "@/shared/ui/button";
import { Input, Label, Select } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { useAddSubscription, useSetCategories, useUpdateSubscription } from "./clients.api";

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

/** True when the override customizes rhythm/planned time (not just the include flag). */
const rhythmEdited = (o?: TaskOverride) =>
  !!o &&
  (o.periodicity !== undefined ||
    o.deadlineOffsetDays !== undefined ||
    o.estimatedMinutes !== undefined);

const PERIOD_LABEL: Record<BillingPeriod, string> = {
  month: "monthly",
  quarter: "quarterly",
  year: "yearly",
};

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

const pill = (selected: boolean) =>
  cn(
    "rounded-(--radius-chip) border px-2.5 py-1 text-[12px] font-medium",
    selected
      ? "border-primary bg-[#eef1fb] text-primary-link"
      : "border-border bg-surface text-muted hover:bg-divider",
  );

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
          className={pill(value.trigger === "on_period_start" && value.day == null)}
          onClick={() => onChange({ trigger: "on_period_start", day: null })}
        >
          Start of period
        </button>
        <button
          type="button"
          className={pill(value.trigger === "on_period_end")}
          onClick={() => onChange({ trigger: "on_period_end", day: null })}
        >
          End of period
        </button>
        <button
          type="button"
          className={pill(value.trigger === "on_period_start" && value.day != null)}
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
    <div className="flex items-center gap-2 text-[13px]">
      <span>Invoice overdue after</span>
      <Input
        className="w-14"
        type="number"
        min={1}
        max={365}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      />
      <span className="text-muted">days after it’s issued (empty = service default)</span>
    </div>
  );
}

/** Subscription table inside the client card's Regular section. */
export function SubscriptionList({ client }: { client: Client }) {
  const { data: services } = useCatalog();
  const update = useUpdateSubscription();
  const [editing, setEditing] = useState<Subscription | undefined>();
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
        return (
          <div key={sub.id} className={cn(!sub.active && "opacity-50")}>
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
              <span className="ml-auto tabular-nums">${(sub.amount / 100).toFixed(2)}</span>
              <span className="text-[12px] text-muted">
                {service?.type === "one_time"
                  ? "per job" // container for manual jobs — period/billing don't apply
                  : `${PERIOD_LABEL[sub.period]} · ${timingLabel(effectiveTiming(sub, service))}`}
              </span>
              <button
                type="button"
                className="text-[12px] font-medium text-primary-link hover:underline"
                onClick={() => setEditing(sub)}
              >
                Edit
              </button>
              <Button
                variant="secondary"
                size="sm"
                disabled={update.isPending}
                onClick={() =>
                  update
                    .mutateAsync({
                      clientId: client.id,
                      subscriptionId: sub.id,
                      input: { active: !sub.active },
                    })
                    .catch(() => {})
                }
              >
                {sub.active ? "Stop" : "Resume"}
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
    </div>
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
      <div className="mb-1 text-[11px] font-medium uppercase tracking-[.4px] text-muted-400">
        Tasks for this client
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
            <button
              type="button"
              className="text-[12px] font-medium text-primary-link hover:underline"
              onClick={() => setEditing(t)}
            >
              Edit
            </button>
            {ov && (
              <button
                type="button"
                className="text-[12px] font-medium text-muted hover:text-danger hover:underline disabled:opacity-50"
                disabled={update.isPending}
                onClick={() => setOverride(t.id, null)}
              >
                Reset
              </button>
            )}
          </div>
        );
      })}
      <p className="mt-1 text-[12px] text-faint">
        Defaults come from the service — tune rhythm, planned time or drop a task for this client.
        Tasks are generated per rhythm with the Tasks stage (S6).
      </p>
      {serverError && <p className="mt-1 text-[12px] text-danger-text">{serverError}</p>}
      {editing && (
        <TaskOverrideModal
          template={editing}
          effective={effectiveTask(editing, overrides[editing.id])}
          oneTime={service.type === "one_time"}
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
  oneTime,
  onApply,
  onClose,
}: {
  template: TaskTemplate;
  effective: EffectiveTask;
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
  const [period, setPeriod] = useState<BillingPeriod>(sub.period);
  const [companyId, setCompanyId] = useState(sub.companyId ?? "");
  const [timing, setTiming] = useState<BillingTiming>(() => effectiveTiming(sub, service));
  const [dueDays, setDueDays] = useState<number | null>(
    sub.dueDays ?? service?.dueDays ?? null,
  );
  const isOneTime = service?.type === "one_time";

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
  const [dueDays, setDueDays] = useState<number | null>(null);
  const [companyId, setCompanyId] = useState("");

  const active = (services ?? []).filter((s) => s.active);
  const selected = active.find((s) => s.id === serviceId);
  // one-time service = container for manual jobs: no billing period, bills per job
  const isOneTime = selected?.type === "one_time";

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
          period: isOneTime ? "month" : period, // stored but unused for one-time
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
        <div className="max-h-56 overflow-y-auto rounded-(--radius-field) border border-border">
          {active.length === 0 && (
            <p className="px-3 py-4 text-[13px] text-muted">
              The catalog is empty — create services on the Services page first.
            </p>
          )}
          {active.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => pick(s.id)}
              className={cn(
                "flex w-full items-center gap-2 border-b border-divider px-3 py-2 text-left text-[13px] last:border-0 hover:bg-divider/40",
                serviceId === s.id && "bg-[#eef1fb]",
              )}
            >
              <ServiceChip name={s.name} color={s.color} />
              <span className="text-[12px] text-muted">
                {s.type === "subscription" ? "Subscription" : "One-time"}
              </span>
              <span className="ml-auto text-[12px] text-muted">
                {s.defaultAmount != null ? `$${(s.defaultAmount / 100).toFixed(0)} expected` : "—"}
              </span>
            </button>
          ))}
        </div>

        {selected && (
          <div className="rounded-(--radius-field) bg-[#f7f8fa] p-3">
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
            {!isOneTime && (
              <div className="mt-2.5">
                <Label>Invoice — when in the period</Label>
                <BillingPills value={timing} onChange={setTiming} />
              </div>
            )}
            <div className="mt-2.5">
              <DueDaysField value={dueDays} onChange={setDueDays} />
            </div>
            <p className="mt-1.5 text-[12px] text-faint">
              {isOneTime
                ? "One-time service = a container for manual jobs. This price only prefills each new task — the actual price is set on the task itself (Tasks, S6)."
                : "Prefilled from the catalog presets — adjust everything for this client."}
            </p>
          </div>
        )}
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
      </div>
    </Modal>
  );
}

/** Category chip picker — full replace of the client's chip set. */
export function CategoriesModal({
  client,
  open,
  onClose,
}: {
  client: Client;
  open: boolean;
  onClose: () => void;
}) {
  const { data: services } = useCatalog();
  const setCategories = useSetCategories();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(client.categories));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async () => {
    try {
      await setCategories.mutateAsync({ clientId: client.id, serviceIds: [...selected] });
      onClose();
    } catch {
      /* surfaced via serverError below */
    }
  };

  const serverError =
    setCategories.error instanceof ApiError ? setCategories.error.message : null;

  return (
    <Modal
      title="Service categories"
      open={open}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={setCategories.isPending} onClick={() => void save()}>
            {setCategories.isPending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-1.5">
        {(services ?? [])
          .filter((s) => s.active || selected.has(s.id))
          .map((s) => (
            <label key={s.id} className="flex cursor-pointer items-center gap-2 py-0.5">
              <input
                type="checkbox"
                checked={selected.has(s.id)}
                onChange={() => toggle(s.id)}
              />
              <ServiceChip name={s.name} color={s.color} />
            </label>
          ))}
        {(services ?? []).length === 0 && (
          <p className="text-[13px] text-muted">The catalog is empty.</p>
        )}
      </div>
      {serverError && <p className="mt-2 text-[12px] text-danger-text">{serverError}</p>}
    </Modal>
  );
}

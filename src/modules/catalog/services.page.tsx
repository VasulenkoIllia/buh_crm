import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { X } from "lucide-react";
import { z } from "zod";
import type { Service, TaskTemplate } from "@shared/schema/catalog";
import type { InvoiceTrigger, Periodicity } from "@shared/schema/enums";
import { useAuth } from "@/app/auth";
import { ApiError } from "@/shared/lib/api";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { FormField, Input, Label } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { Segmented } from "@/shared/ui/segmented";
import {
  useAddTemplate,
  useCatalog,
  useCreateService,
  useDeleteTemplate,
  useUpdateService,
} from "./catalog.api";
import { ServiceChip } from "./service-chip";

const TRIGGER_LABEL: Record<InvoiceTrigger, string> = {
  on_create: "On create",
  on_complete: "On complete",
  on_period_start: "On period start",
};
const RHYTHM_LABEL: Record<Periodicity, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
  once: "Once",
};

function ruleSummary(s: Pick<Service, "invoiceTrigger" | "invoiceDay" | "defaultAmount">) {
  const parts = [TRIGGER_LABEL[s.invoiceTrigger]];
  if (s.invoiceDay) parts.push(`day ${s.invoiceDay} of the period`);
  if (s.defaultAmount != null) parts.push(`expected $${(s.defaultAmount / 100).toFixed(0)}`);
  return parts.join(" · ");
}

export function ServicesPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { data: services, isLoading, error } = useCatalog();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Service | undefined>();
  const [taskFor, setTaskFor] = useState<Service | undefined>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (isLoading) return <p className="text-[13px] text-muted">Loading…</p>;
  if (error || !services)
    return <p className="text-[13px] text-danger-text">Failed to load the catalog.</p>;

  return (
    <div className="mx-auto max-w-[820px]">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-[20px] font-semibold">Service catalog</h1>
        {isAdmin && (
          <Button
            onClick={() => {
              setEditing(undefined);
              setEditorOpen(true);
            }}
          >
            + New item
          </Button>
        )}
      </div>
      <p className="mb-4 text-[13px] text-muted-400">
        Universal catalog item: type, tasks and expected price — the final price is set per
        client when the service is assigned.
      </p>

      {services.length === 0 ? (
        <div className="rounded-(--radius-panel) border border-dashed border-[#cfd4db] bg-surface p-12 text-center">
          <div className="text-[15px] font-semibold">No services yet</div>
          <p className="mt-1 text-[13px] text-muted">
            Create the first catalog item — it becomes the shared category list.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-(--radius-panel) border border-border bg-surface">
          <div className="grid grid-cols-[20px_1fr_130px_90px_110px] gap-x-3 border-b border-[#eef0f3] bg-[#fafbfc] px-4 py-2.5 text-[11px] font-medium uppercase tracking-[.4px] text-muted-400">
            <div />
            <div>Name</div>
            <div>Type</div>
            <div className="text-right">Clients</div>
            <div className="text-right">Actions</div>
          </div>
          {services.map((service) => (
            <div key={service.id}>
              <div
                className="grid cursor-pointer grid-cols-[20px_1fr_130px_90px_110px] items-center gap-x-3 border-b border-divider px-4 py-[13px] text-[13px] hover:bg-divider/40"
                onClick={() => toggle(service.id)}
              >
                <span
                  className={cn(
                    "text-[11px] text-muted transition-transform",
                    expanded.has(service.id) && "rotate-90",
                  )}
                >
                  ▸
                </span>
                <div className="flex min-w-0 items-center gap-2">
                  <ServiceChip name={service.name} color={service.color} />
                  <span className="text-[12px] text-[#9aa1ab]">
                    · {service.taskTemplates.length} tasks
                  </span>
                  {!service.active && (
                    <span className="text-[11px] uppercase text-faint">inactive</span>
                  )}
                </div>
                <div>
                  <span className="rounded-(--radius-chip) bg-divider px-2 py-0.5 text-[12px] font-medium">
                    {service.type === "subscription" ? "Subscription" : "One-time"}
                  </span>
                </div>
                <div className="text-right text-[#6b7280]">{service.clientsCount}</div>
                <div className="text-right" onClick={(e) => e.stopPropagation()}>
                  {isAdmin && (
                    <button
                      type="button"
                      className="text-[12px] font-medium text-primary-link hover:underline"
                      onClick={() => {
                        setEditing(service);
                        setEditorOpen(true);
                      }}
                    >
                      Edit
                    </button>
                  )}
                </div>
              </div>

              {expanded.has(service.id) && (
                <ExpandedPanel
                  service={service}
                  isAdmin={isAdmin}
                  onAddTask={() => setTaskFor(service)}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {editorOpen && (
        <ServiceEditorModal
          open={editorOpen}
          service={editing}
          onClose={() => setEditorOpen(false)}
        />
      )}
      {taskFor && (
        <TaskTemplateModal service={taskFor} open onClose={() => setTaskFor(undefined)} />
      )}
    </div>
  );
}

function ExpandedPanel({
  service,
  isAdmin,
  onAddTask,
}: {
  service: Service;
  isAdmin: boolean;
  onAddTask: () => void;
}) {
  const removeTemplate = useDeleteTemplate();
  return (
    <div className="border-b border-[#f2f4f6] bg-[#fafbfc] px-4 pb-3.5 pl-10 pt-1.5">
      <span className="inline-flex rounded-[5px] bg-[#eef1fb] px-2 py-[3px] text-[12px] font-medium text-[#2f4fd6]">
        💸 {ruleSummary(service)}
      </span>
      <div className="mt-2 text-[11px] font-medium uppercase tracking-[.4px] text-muted-400">
        Item tasks
      </div>
      {service.taskTemplates.length === 0 && (
        <p className="mt-1 text-[12px] text-faint">No tasks yet.</p>
      )}
      {service.taskTemplates.map((t) => (
        <TemplateRow
          key={t.id}
          template={t}
          isAdmin={isAdmin}
          onDelete={() =>
            removeTemplate
              .mutateAsync({ serviceId: service.id, templateId: t.id })
              .catch(() => {})
          }
        />
      ))}
      {isAdmin && (
        <button
          type="button"
          className="mt-1.5 text-[13px] font-medium text-primary-link hover:underline"
          onClick={onAddTask}
        >
          + Add task to item
        </button>
      )}
    </div>
  );
}

function TemplateRow({
  template,
  isAdmin,
  onDelete,
}: {
  template: TaskTemplate;
  isAdmin: boolean;
  onDelete: () => void;
}) {
  const rhythm = [
    RHYTHM_LABEL[template.periodicity],
    template.dayOfPeriod ? `day ${template.dayOfPeriod}` : null,
    template.deadlineOffsetDays != null ? `deadline +${template.deadlineOffsetDays}d` : null,
    template.estimatedMinutes != null ? `~${template.estimatedMinutes} min` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex items-center gap-2 py-1 text-[13px]">
      <span className="h-[7px] w-[7px] flex-none rounded-full bg-[#3355dd]" />
      <span className="min-w-0 truncate">{template.name}</span>
      <span className="ml-auto text-[12px] text-[#6b7280]">{rhythm}</span>
      {isAdmin && (
        <button
          type="button"
          aria-label={`Remove ${template.name}`}
          className="text-[#c23434] hover:opacity-70"
          onClick={onDelete}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}

// ── Service editor modal ─────────────────────────────────────────────────────

const serviceFormSchema = z.object({
  name: z.string().trim().min(1, "Required").max(60),
  type: z.enum(["subscription", "one_time"]),
  invoiceTrigger: z.enum(["on_create", "on_complete", "on_period_start"]),
  invoiceDay: z.number().int().min(1).max(31).nullable(),
  defaultAmount: z.number().int().nonnegative().nullable(),
});
type ServiceFormValues = z.infer<typeof serviceFormSchema>;

function ServiceEditorModal({
  open,
  service,
  onClose,
}: {
  open: boolean;
  service?: Service;
  onClose: () => void;
}) {
  const create = useCreateService();
  const update = useUpdateService();

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<ServiceFormValues>({
    resolver: zodResolver(serviceFormSchema),
    defaultValues: {
      name: service?.name ?? "",
      type: service?.type === "one_time" ? "one_time" : "subscription",
      defaultAmount: service?.defaultAmount ?? null,
      invoiceTrigger: service?.invoiceTrigger ?? "on_create",
      invoiceDay: service?.invoiceDay ?? null,
    },
  });

  const trigger = watch("invoiceTrigger");
  const day = watch("invoiceDay");
  const amount = watch("defaultAmount");

  const onSubmit = handleSubmit(async (values) => {
    try {
      if (service) await update.mutateAsync({ id: service.id, input: values });
      else await create.mutateAsync(values);
      onClose();
    } catch {
      /* surfaced via serverError below */
    }
  });

  const mutation = service ? update : create;
  const serverError = mutation.error instanceof ApiError ? mutation.error.message : null;

  return (
    <Modal
      title={service ? "Edit catalog item" : "New catalog item"}
      open={open}
      onClose={onClose}
      footer={
        <>
          {service && (
            <Button
              variant="secondary"
              disabled={update.isPending}
              onClick={() =>
                update
                  .mutateAsync({ id: service.id, input: { active: !service.active } })
                  .then(onClose)
                  .catch(() => {})
              }
            >
              {service.active ? "Deactivate" : "Activate"}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="service-form" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <form id="service-form" onSubmit={onSubmit} className="space-y-3.5" noValidate>
        <FormField label="Service name" htmlFor="s-name" error={errors.name?.message}>
          <Input
            id="s-name"
            placeholder="e.g. Bookkeeping"
            error={!!errors.name}
            {...register("name")}
          />
        </FormField>

        <div>
          <Label>Type</Label>
          <Segmented
            value={watch("type")}
            onChange={(v) =>
              setValue("type", v as ServiceFormValues["type"], { shouldDirty: true })
            }
            options={[
              { value: "subscription", label: "Subscription" },
              { value: "one_time", label: "One-time" },
            ]}
          />
        </div>

        <div className="rounded-[10px] border border-[#e6e9ee] p-3.5">
          <Label>Billing — invoice rule</Label>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(TRIGGER_LABEL) as InvoiceTrigger[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setValue("invoiceTrigger", t, { shouldDirty: true })}
                className={cn(
                  "rounded-(--radius-chip) border px-2.5 py-1 text-[12px] font-medium",
                  trigger === t
                    ? "border-primary bg-[#eef1fb] text-primary-link"
                    : "border-border bg-surface text-muted hover:bg-divider",
                )}
              >
                {TRIGGER_LABEL[t]}
              </button>
            ))}
          </div>
          <div className="mt-2.5 flex items-center gap-2 text-[13px]">
            <span>On day</span>
            <Input
              className="w-14"
              type="number"
              min={1}
              max={31}
              value={day ?? ""}
              onChange={(e) =>
                setValue("invoiceDay", e.target.value ? Number(e.target.value) : null, {
                  shouldDirty: true,
                })
              }
            />
            <span className="text-muted">of the period</span>
          </div>
          <div className="mt-2.5 flex items-center gap-2 text-[13px]">
            <span>Expected price</span>
            <span className="text-muted">$</span>
            <Input
              className="w-24"
              type="number"
              min={0}
              value={amount != null ? amount / 100 : ""}
              onChange={(e) =>
                setValue(
                  "defaultAmount",
                  e.target.value ? Math.round(Number(e.target.value) * 100) : null,
                  { shouldDirty: true },
                )
              }
            />
          </div>
          <div className="mt-2.5 rounded-[6px] bg-[#eef1fb] px-2.5 py-1.5 text-[12px] font-medium text-[#2f4fd6]">
            → {ruleSummary({ invoiceTrigger: trigger, invoiceDay: day ?? null, defaultAmount: amount ?? null })}
          </div>
          <p className="mt-2 text-[12px] text-faint">
            The expected price prefills the per-client form — the final price is set when the
            service is added to a client.
          </p>
        </div>
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
      </form>
    </Modal>
  );
}

// ── Task template modal ──────────────────────────────────────────────────────

const DAY_MAX: Record<string, number> = { weekly: 7, monthly: 31, quarterly: 92, yearly: 366 };
const templateFormSchema = z
  .object({
    name: z.string().trim().min(1, "Required").max(80),
    periodicity: z.enum(["weekly", "monthly", "quarterly", "yearly", "once"]),
    dayOfPeriod: z.number().int().nullable(),
    deadlineOffsetDays: z.number().int().min(0).max(90).nullable(),
    estimatedMinutes: z.number().int().min(1).nullable(),
  })
  .refine(
    (v) =>
      v.dayOfPeriod == null ||
      (DAY_MAX[v.periodicity] !== undefined &&
        v.dayOfPeriod >= 1 &&
        v.dayOfPeriod <= DAY_MAX[v.periodicity]),
    { path: ["dayOfPeriod"], message: "Day must fit the rhythm" },
  );
type TemplateFormValues = z.infer<typeof templateFormSchema>;

const DEADLINE_PRESETS = [1, 2, 5] as const;

function TaskTemplateModal({
  service,
  open,
  onClose,
}: {
  service: Service;
  open: boolean;
  onClose: () => void;
}) {
  const add = useAddTemplate();
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<TemplateFormValues>({
    resolver: zodResolver(templateFormSchema),
    defaultValues: {
      name: "",
      periodicity: "monthly",
      dayOfPeriod: null,
      deadlineOffsetDays: null,
      estimatedMinutes: null,
    },
  });

  const periodicity = watch("periodicity");
  const offset = watch("deadlineOffsetDays");

  const onSubmit = handleSubmit(async (values) => {
    try {
      await add.mutateAsync({ serviceId: service.id, input: { ...values, billable: true } });
      onClose();
    } catch {
      /* surfaced via serverError below */
    }
  });

  const serverError = add.error instanceof ApiError ? add.error.message : null;

  return (
    <Modal
      title={`Task for “${service.name}”`}
      open={open}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="template-form" disabled={isSubmitting}>
            {isSubmitting ? "Adding…" : "Add task"}
          </Button>
        </>
      }
    >
      <form id="template-form" onSubmit={onSubmit} className="space-y-3.5" noValidate>
        <FormField label="Task name" htmlFor="t-name" error={errors.name?.message}>
          <Input
            id="t-name"
            placeholder="e.g. Bank reconciliation"
            error={!!errors.name}
            {...register("name")}
          />
        </FormField>

        <div>
          <Label>Rhythm / frequency</Label>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(RHYTHM_LABEL) as Periodicity[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  setValue("periodicity", p, { shouldDirty: true });
                  if (p === "once") setValue("dayOfPeriod", null);
                }}
                className={cn(
                  "rounded-(--radius-chip) border px-2.5 py-1 text-[12px] font-medium",
                  periodicity === p
                    ? "border-primary bg-[#eef1fb] text-primary-link"
                    : "border-border bg-surface text-muted hover:bg-divider",
                )}
              >
                {RHYTHM_LABEL[p]}
              </button>
            ))}
          </div>
          {periodicity !== "once" && (
            <div className="mt-2 flex items-center gap-2 text-[13px]">
              <span>On day</span>
              <Input
                className="w-14"
                type="number"
                min={1}
                value={watch("dayOfPeriod") ?? ""}
                onChange={(e) =>
                  setValue("dayOfPeriod", e.target.value ? Number(e.target.value) : null, {
                    shouldDirty: true,
                  })
                }
              />
              <span className="text-muted">of the period</span>
              {errors.dayOfPeriod && (
                <span className="text-[12px] text-danger-text">{errors.dayOfPeriod.message}</span>
              )}
            </div>
          )}
        </div>

        <div>
          <Label>Deadline (offset from each task’s creation date)</Label>
          <div className="flex flex-wrap gap-1.5">
            {DEADLINE_PRESETS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setValue("deadlineOffsetDays", d, { shouldDirty: true })}
                className={cn(
                  "rounded-(--radius-chip) border px-2.5 py-1 text-[12px] font-medium",
                  offset === d
                    ? "border-primary bg-[#eef1fb] text-primary-link"
                    : "border-border bg-surface text-muted hover:bg-divider",
                )}
              >
                +{d} days
              </button>
            ))}
            <button
              type="button"
              onClick={() => setValue("deadlineOffsetDays", null, { shouldDirty: true })}
              className={cn(
                "rounded-(--radius-chip) border px-2.5 py-1 text-[12px] font-medium",
                offset == null
                  ? "border-primary bg-[#eef1fb] text-primary-link"
                  : "border-border bg-surface text-muted hover:bg-divider",
              )}
            >
              none
            </button>
            <Input
              className="w-16"
              type="number"
              min={0}
              max={90}
              placeholder="flex"
              value={offset != null && !DEADLINE_PRESETS.includes(offset as 1 | 2 | 5) ? offset : ""}
              onChange={(e) =>
                setValue("deadlineOffsetDays", e.target.value ? Number(e.target.value) : null, {
                  shouldDirty: true,
                })
              }
            />
          </div>
        </div>

        <div className="flex items-center gap-2 text-[13px]">
          <span>Planned time</span>
          <Input
            className="w-20"
            type="number"
            min={1}
            placeholder="min"
            value={watch("estimatedMinutes") ?? ""}
            onChange={(e) =>
              setValue("estimatedMinutes", e.target.value ? Number(e.target.value) : null, {
                shouldDirty: true,
              })
            }
          />
          <span className="text-muted">minutes — per-client override comes with Tasks (S6)</span>
        </div>
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
      </form>
    </Modal>
  );
}

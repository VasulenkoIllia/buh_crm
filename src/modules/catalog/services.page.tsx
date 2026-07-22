import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { rhythmValid } from "@shared/schema/catalog";
import type { Service, TaskTemplate } from "@shared/schema/catalog";
import { useAuth } from "@/app/auth";
import { ApiError } from "@/shared/lib/api";
import { CATEGORY_PALETTE } from "@/shared/lib/colors";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { FormField, Input, Label } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { Segmented } from "@/shared/ui/segmented";
import {
  useAddTemplate,
  useCatalog,
  useCreateService,
  useDeleteService,
  useDeleteTemplate,
  useUpdateService,
  useUpdateTemplate,
} from "./catalog.api";
import { ServiceChip } from "./service-chip";
import {
  TaskRhythmFields,
  pillCls,
  rhythmSummary,
  type RhythmValue,
} from "./task-rhythm-fields";

/**
 * Billing timing lives on the service; the billing FREQUENCY (month/quarter/year)
 * is the client's subscription `period` — so the summary talks about "the period".
 */
function ruleSummary(
  s: Pick<Service, "type" | "invoiceTrigger" | "invoiceDay" | "defaultAmount"> & {
    dueDays?: number | null;
  },
) {
  let when: string;
  if (s.type === "one_time") {
    when = s.invoiceTrigger === "on_complete" ? "Invoice on complete" : "Invoice on create";
  } else if (s.invoiceTrigger === "on_period_end") {
    when = "Invoice at the end of the period (last day)";
  } else if (s.invoiceDay != null) {
    when = `Invoice on day ${s.invoiceDay} of the period`;
  } else {
    when = "Invoice at the start of the period (1st)";
  }
  const parts = [when];
  if (s.defaultAmount != null) parts.push(`expected $${(s.defaultAmount / 100).toFixed(0)}`);
  if (s.dueDays != null) parts.push(`overdue after ${s.dueDays}d`);
  return parts.join(" · ");
}

export function ServicesPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { data: services, isLoading, error } = useCatalog();
  const updateService = useUpdateService();
  const deleteService = useDeleteService();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Service | undefined>();
  const [taskModal, setTaskModal] = useState<
    { service: Service; template?: TaskTemplate } | undefined
  >();
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
          <div className="grid grid-cols-[20px_1fr_120px_70px_190px] gap-x-3 border-b border-[#eef0f3] bg-[#fafbfc] px-4 py-2.5 text-[11px] font-medium uppercase tracking-[.4px] text-muted-400">
            <div />
            <div>Name</div>
            <div>Type</div>
            <div className="text-right">Clients</div>
            <div className="text-right">Actions</div>
          </div>
          {services.map((service) => (
            <div key={service.id}>
              <div
                className="grid cursor-pointer grid-cols-[20px_1fr_120px_70px_190px] items-center gap-x-3 border-b border-divider px-4 py-[13px] text-[13px] hover:bg-divider/40"
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
                <div
                  className="flex items-center justify-end gap-2.5 text-right"
                  onClick={(e) => e.stopPropagation()}
                >
                  {isAdmin && (
                    <>
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
                      <button
                        type="button"
                        disabled={updateService.isPending}
                        className="text-[12px] font-medium text-muted hover:text-danger hover:underline disabled:opacity-50"
                        onClick={() =>
                          updateService
                            .mutateAsync({
                              id: service.id,
                              input: { active: !service.active },
                            })
                            .catch(() => {})
                        }
                      >
                        {service.active ? "Deactivate" : "Activate"}
                      </button>
                      <button
                        type="button"
                        disabled={deleteService.isPending}
                        className="text-[12px] font-medium text-muted hover:text-danger hover:underline disabled:opacity-50"
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Delete “${service.name}”? Possible only while no client uses it.`,
                            )
                          )
                            return;
                          deleteService
                            .mutateAsync(service.id)
                            .catch((e) =>
                              window.alert(e instanceof Error ? e.message : "Delete failed"),
                            );
                        }}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>

              {expanded.has(service.id) && (
                <ExpandedPanel
                  service={service}
                  isAdmin={isAdmin}
                  onAddTask={() => setTaskModal({ service })}
                  onEditTask={(template) => setTaskModal({ service, template })}
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
      {taskModal && (
        <TaskTemplateModal
          service={taskModal.service}
          template={taskModal.template}
          open
          onClose={() => setTaskModal(undefined)}
        />
      )}
    </div>
  );
}

function ExpandedPanel({
  service,
  isAdmin,
  onAddTask,
  onEditTask,
}: {
  service: Service;
  isAdmin: boolean;
  onAddTask: () => void;
  onEditTask: (template: TaskTemplate) => void;
}) {
  const removeTemplate = useDeleteTemplate();
  return (
    <div className="border-b border-[#f2f4f6] bg-[#fafbfc] px-4 pb-3.5 pl-10 pt-1.5">
      <span className="inline-flex rounded-[5px] bg-[#eef1fb] px-2 py-[3px] text-[12px] font-medium text-[#2f4fd6]">
        💸 {ruleSummary(service)}
      </span>
      {(() => {
        const total = service.taskTemplates.reduce((sum, t) => sum + (t.estimatedMinutes ?? 0), 0);
        return total > 0 ? (
          <span className="ml-1.5 inline-flex rounded-[5px] bg-divider px-2 py-[3px] text-[12px] font-medium text-ink-700">
            ⏱ ~{total} min planned / period
          </span>
        ) : null;
      })()}
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
          onEdit={() => onEditTask(t)}
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
  onEdit,
  onDelete,
}: {
  template: TaskTemplate;
  isAdmin: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const rhythm = rhythmSummary(template);
  return (
    <div className="flex items-center gap-2 py-1 text-[13px]">
      <span className="h-[7px] w-[7px] flex-none rounded-full bg-[#3355dd]" />
      <span className="min-w-0 truncate">{template.name}</span>
      <span className="ml-auto text-[12px] text-[#6b7280]">{rhythm}</span>
      {isAdmin && (
        <span className="inline-flex items-center gap-2.5">
          <button
            type="button"
            className="text-[12px] font-medium text-primary-link hover:underline"
            onClick={onEdit}
          >
            Edit
          </button>
          <button
            type="button"
            className="text-[12px] font-medium text-muted hover:text-danger hover:underline"
            onClick={onDelete}
          >
            Delete
          </button>
        </span>
      )}
    </div>
  );
}

// ── Service editor modal ─────────────────────────────────────────────────────

const serviceFormSchema = z.object({
  name: z.string().trim().min(1, "Required").max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  type: z.enum(["subscription", "one_time"]),
  invoiceTrigger: z.enum(["on_create", "on_complete", "on_period_start", "on_period_end"]),
  invoiceDay: z.number().int().min(1).max(31).nullable(),
  defaultAmount: z.number().int().nonnegative().nullable(),
  dueDays: z.number().int().min(1).max(365).nullable(),
});
type ServiceFormValues = z.infer<typeof serviceFormSchema>;

const SUB_TRIGGERS = [
  { value: "on_period_start", label: "Start of period" },
  { value: "on_period_end", label: "End of period" },
] as const;
const ONE_TIME_TRIGGERS = [
  { value: "on_create", label: "On create" },
  { value: "on_complete", label: "On complete" },
] as const;

/** Legacy combos (pre-2026-07-20 services) snap to the nearest valid rule. */
function normalizedBilling(service?: Service): {
  trigger: ServiceFormValues["invoiceTrigger"];
  day: number | null;
} {
  if (!service) return { trigger: "on_period_start", day: null }; // default: start of period (1st)
  if (service.type === "one_time") {
    return {
      trigger: service.invoiceTrigger === "on_complete" ? "on_complete" : "on_create",
      day: null,
    };
  }
  if (service.invoiceTrigger === "on_period_end") return { trigger: "on_period_end", day: null };
  return { trigger: "on_period_start", day: service.invoiceDay ?? null };
}

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
  const billing = normalizedBilling(service);

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
      color: service?.color,
      type: service?.type === "one_time" ? "one_time" : "subscription",
      defaultAmount: service?.defaultAmount ?? null,
      invoiceTrigger: billing.trigger,
      invoiceDay: billing.day,
      dueDays: service?.dueDays ?? null,
    },
  });

  const type = watch("type");
  const trigger = watch("invoiceTrigger");
  const day = watch("invoiceDay");
  const amount = watch("defaultAmount");
  const dueDays = watch("dueDays");

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
            value={type}
            onChange={(v) => {
              setValue("type", v as ServiceFormValues["type"], { shouldDirty: true });
              // billing options differ per type — snap to that type's default
              setValue("invoiceTrigger", v === "one_time" ? "on_create" : "on_period_start", {
                shouldDirty: true,
              });
              setValue("invoiceDay", null, { shouldDirty: true });
            }}
            options={[
              { value: "subscription", label: "Subscription" },
              { value: "one_time", label: "One-time" },
            ]}
          />
        </div>

        <div>
          <Label>Color</Label>
          <div className="flex items-center gap-1.5">
            {CATEGORY_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Color ${c}`}
                onClick={() => setValue("color", c, { shouldDirty: true })}
                className={cn(
                  "h-7 w-7 rounded-full border-2 transition-transform",
                  watch("color") === c
                    ? "scale-110 border-ink"
                    : "border-transparent hover:scale-105",
                )}
                style={{ backgroundColor: c }}
              />
            ))}
            {!watch("color") && (
              <span className="ml-1 text-[12px] text-faint">auto if not picked</span>
            )}
          </div>
        </div>

        <div className="rounded-[10px] border border-[#e6e9ee] p-3.5">
          <Label>Billing — when is the invoice issued</Label>
          <div className="flex flex-wrap gap-1.5">
            {(type === "one_time" ? ONE_TIME_TRIGGERS : SUB_TRIGGERS).map((t) => {
              const selected =
                t.value === "on_period_start"
                  ? trigger === "on_period_start" && day == null
                  : trigger === t.value;
              return (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => {
                    setValue("invoiceTrigger", t.value, { shouldDirty: true });
                    setValue("invoiceDay", null, { shouldDirty: true });
                  }}
                  className={pillCls(selected)}
                >
                  {t.label}
                </button>
              );
            })}
            {type === "subscription" && (
              <button
                type="button"
                onClick={() => {
                  setValue("invoiceTrigger", "on_period_start", { shouldDirty: true });
                  setValue("invoiceDay", 5, { shouldDirty: true });
                }}
                className={pillCls(trigger === "on_period_start" && day != null)}
              >
                Custom day
              </button>
            )}
          </div>
          {type === "subscription" && trigger === "on_period_start" && day != null && (
            <div className="mt-2.5 flex items-center gap-2 text-[13px]">
              <span>On day</span>
              <Input
                className="w-14"
                type="number"
                min={1}
                max={31}
                value={day}
                onChange={(e) =>
                  setValue("invoiceDay", e.target.value ? Number(e.target.value) : 1, {
                    shouldDirty: true,
                  })
                }
              />
              <span className="text-muted">of the period</span>
            </div>
          )}
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
          <div className="mt-2.5 flex items-center gap-2 text-[13px]">
            <span>Overdue after</span>
            <Input
              className="w-14"
              type="number"
              min={1}
              max={365}
              value={dueDays ?? ""}
              onChange={(e) =>
                setValue("dueDays", e.target.value ? Number(e.target.value) : null, {
                  shouldDirty: true,
                })
              }
            />
            <span className="text-muted">days after the invoice is issued (empty = never)</span>
          </div>
          <div className="mt-2.5 rounded-[6px] bg-[#eef1fb] px-2.5 py-1.5 text-[12px] font-medium text-[#2f4fd6]">
            →{" "}
            {ruleSummary({
              type,
              invoiceTrigger: trigger,
              invoiceDay: day ?? null,
              defaultAmount: amount ?? null,
              dueDays: dueDays ?? null,
            })}
          </div>
          {type === "subscription" && (
            <p className="mt-2 text-[12px] text-faint">
              How often (monthly / quarterly / yearly) is chosen per client on their
              subscription — here you only set WHEN in that period the invoice is issued.
            </p>
          )}
          <p className="mt-2 text-[12px] text-faint">
            The expected price prefills the per-client form — the final price is set when the
            service is added to a client.
          </p>
          <p className="mt-1 text-[12px] text-faint">
            Work rhythm and planned time live on the item's tasks — expand the row and use
            “+ Add task to item”.
          </p>
        </div>
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
      </form>
    </Modal>
  );
}

// ── Task template modal ──────────────────────────────────────────────────────

const templateFormSchema = z
  .object({
    name: z.string().trim().min(1, "Required").max(80),
    periodicity: z.enum(["weekly", "monthly", "quarterly", "yearly", "once"]),
    dayOfPeriod: z.number().int().min(-1).max(31).nullable(),
    monthOfPeriod: z.number().int().min(1).max(12).nullable(),
    deadlineOffsetDays: z.number().int().min(0).max(90).nullable(),
    estimatedMinutes: z.number().int().min(1).nullable(),
  })
  .refine(rhythmValid, { path: ["dayOfPeriod"], message: "Day/month don't fit the frequency" });
type TemplateFormValues = z.infer<typeof templateFormSchema>;

function TaskTemplateModal({
  service,
  template,
  open,
  onClose,
}: {
  service: Service;
  template?: TaskTemplate;
  open: boolean;
  onClose: () => void;
}) {
  const add = useAddTemplate();
  const update = useUpdateTemplate();
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<TemplateFormValues>({
    resolver: zodResolver(templateFormSchema),
    defaultValues: {
      name: template?.name ?? "",
      periodicity: template?.periodicity ?? "monthly",
      dayOfPeriod: template ? template.dayOfPeriod : 1,
      monthOfPeriod: template?.monthOfPeriod ?? null,
      deadlineOffsetDays: template?.deadlineOffsetDays ?? null,
      estimatedMinutes: template?.estimatedMinutes ?? null,
    },
  });

  const rhythm: RhythmValue = {
    periodicity: watch("periodicity"),
    dayOfPeriod: watch("dayOfPeriod"),
    monthOfPeriod: watch("monthOfPeriod"),
    deadlineOffsetDays: watch("deadlineOffsetDays"),
    estimatedMinutes: watch("estimatedMinutes"),
  };
  const applyRhythm = (patch: Partial<RhythmValue>) => {
    for (const [k, v] of Object.entries(patch)) {
      setValue(k as keyof TemplateFormValues, v as never, { shouldDirty: true });
    }
  };

  const onSubmit = handleSubmit(async (values) => {
    try {
      if (template) {
        await update.mutateAsync({
          serviceId: service.id,
          templateId: template.id,
          input: values,
        });
      } else {
        await add.mutateAsync({ serviceId: service.id, input: { ...values, billable: true } });
      }
      onClose();
    } catch {
      /* surfaced via serverError below */
    }
  });

  const mutation = template ? update : add;
  const serverError = mutation.error instanceof ApiError ? mutation.error.message : null;

  return (
    <Modal
      title={template ? `Edit task — “${service.name}”` : `Task for “${service.name}”`}
      open={open}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="template-form" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : template ? "Save" : "Add task"}
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

        <TaskRhythmFields
          value={rhythm}
          onChange={applyRhythm}
          dayError={errors.dayOfPeriod?.message}
          plannedHint="the default; per-client override lives on the client's subscription"
        />
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
      </form>
    </Modal>
  );
}

import { useState } from "react";
import { Building2, Pencil, Power, Star, Trash2, Users } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { rhythmValid } from "@shared/schema/catalog";
import type { Service, TaskTemplate } from "@shared/schema/catalog";
import { useAuth } from "@/app/auth";
import { useUsers } from "@/modules/users";
import { ApiError } from "@/shared/lib/api";
import { CATEGORY_PALETTE } from "@/shared/lib/colors";
import { cn } from "@/shared/lib/cn";
import { AssigneePicker } from "@/shared/ui/assignee-picker";
import { Button, IconButton } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";
import { ChecklistEditor } from "@/shared/ui/checklist-editor";
import { FormField, Input, Label, Textarea } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { pillCls } from "@/shared/ui/pill";
import { InfoHint } from "@/shared/ui/info-hint";
import { Segmented } from "@/shared/ui/segmented";
import { SearchInput } from "@/shared/ui/search-input";
import { Tabs } from "@/shared/ui/tabs";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { resolveDrop } from "@/shared/lib/drop-target";
import {
  useAddTemplate,
  useCatalog,
  useCreateService,
  useDeleteService,
  useMoveService,
  useDeleteTemplate,
  useUpdateService,
  useUpdateTemplate,
} from "./catalog.api";
import { ServiceChip } from "./service-chip";
import { TaskRhythmFields, rhythmSummary, type RhythmValue } from "./task-rhythm-fields";

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
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"external" | "internal">("external");

  const move = useMoveService();
  // The handle is a focusable button, so a keyboard reaches it either way; without the keyboard
  // sensor it was a tab stop that answered nothing. Space lifts, arrows move, Space drops.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // row actions (default flag / deactivate) can be refused by the server — show why
  const rowError = updateService.error instanceof ApiError ? updateService.error.message : null;

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

  const internalCount = services.filter((s) => s.type === "internal").length;
  const externalCount = services.length - internalCount;
  /**
   * The phrase is matched HERE, in the browser, and that is the right place for once: the whole
   * catalog is loaded in one read — templates included — and it is never truncated, so there is no
   * page beyond which a typed word would stop finding things. (The Archive's lists are capped, so
   * their search had to go to the database. Same feature, opposite answer, for a reason.)
   *
   * An internal category is a CONTAINER of templates, and a template is what people actually go
   * looking for — so a category matches on its templates too, and says so by opening itself.
   */
  const q = search.trim().toLowerCase();
  const nameHit = (s: Service) => s.name.toLowerCase().includes(q);
  const templateHit = (s: Service) => s.taskTemplates.some((t) => t.name.toLowerCase().includes(q));
  const matches = (s: Service) => !q || nameHit(s) || templateHit(s);
  /** Matched only by something inside it — open the row, or the match is invisible. */
  const matchedInside = (s: Service) => !!q && !nameHit(s) && templateHit(s);

  const inTab = (s: Service) => (tab === "internal" ? s.type === "internal" : s.type !== "internal");
  const shown = services.filter((s) => inTab(s) && matches(s));

  /**
   * The catalog is ONE order and the tabs are a filter over it, so the drop is resolved against
   * the rows on screen and sent as an ANCHOR — "put me after that service". The server renumbers
   * the whole catalog against it, which is what keeps the other tab's rows where they were.
   */
  const onDragEnd = (event: DragEndEvent) => {
    const id = String(event.active.id);
    const target = resolveDrop(
      new Map([["catalog", shown.map((x) => x.id)]]),
      id,
      event.over ? String(event.over.id) : null,
    );
    if (!target) return;
    move.mutate(
      { id, input: { afterServiceId: target.afterId } },
      {
        onError: (err) =>
          window.alert(
            `Could not move the service.\n\n` +
              (err instanceof Error ? err.message : "Please try again."),
          ),
      },
    );
  };

  const TABS = [
    { value: "external" as const, label: "External", icon: Users, count: externalCount },
    { value: "internal" as const, label: "Internal", icon: Building2, count: internalCount },
  ];

  return (
    <div className="mx-auto max-w-[820px]">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-[20px] font-semibold">Service catalog</h1>
        <SearchInput
          className="ml-auto mr-3 w-64"
          placeholder="🔍 Search: service, task template…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {isAdmin && (
          <Button
            onClick={() => {
              setEditing(undefined);
              setEditorOpen(true);
            }}
          >
            {tab === "internal" ? "+ New internal category" : "+ New service"}
          </Button>
        )}
      </div>
      <p className="mb-3 text-[13px] text-muted-400">
        {tab === "external"
          ? "Client-facing services: type, tasks and expected price — the final price is set per client when assigned."
          : "Internal recurring tasks (no client, no billing): each template auto-generates a firm-internal task on its rhythm."}
      </p>

      <Tabs className="mb-4" value={tab} onChange={setTab} options={TABS} />

      {shown.length === 0 ? (
        <div className="rounded-(--radius-panel) border border-dashed border-[#cfd4db] bg-surface p-12 text-center">
          {/* an empty catalog and an empty SEARCH are different facts, and "create the first
              service" is bad advice when there are forty of them and the phrase simply missed */}
          <div className="text-[15px] font-semibold">
            {q
              ? "Nothing matches that"
              : tab === "external"
                ? "No services yet"
                : "No internal templates yet"}
          </div>
          <p className="mt-1 text-[13px] text-muted">
            {q
              ? "Try another phrase, clear the search, or look in the other tab."
              : tab === "external"
                ? "Create the first service — it becomes the shared category list."
                : "Create an internal category, then add recurring task templates to it."}
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
          {/* Only an admin can reorder — the catalog's order is the firm's, like every other change
              to it — so only an admin gets a drag context around the rows. */}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={shown.map((x) => x.id)} strategy={verticalListSortingStrategy}>
          {shown.map((service) => (
            <SortableServiceRow key={service.id} id={service.id} draggable={isAdmin}>
              <div
                className="grid cursor-pointer grid-cols-[20px_1fr_120px_70px_190px] items-center gap-x-3 border-b border-divider px-4 py-[13px] text-[13px] hover:bg-divider/40"
                onClick={() => toggle(service.id)}
              >
                <span
                  className={cn(
                    "text-[11px] text-muted transition-transform",
                    (expanded.has(service.id) || matchedInside(service)) && "rotate-90",
                  )}
                >
                  ▸
                </span>
                <div className="flex min-w-0 items-center gap-2">
                  <ServiceChip name={service.name} color={service.color} />
                  <span className="text-[12px] text-[#9aa1ab]">
                    · {service.taskTemplates.length} tasks
                  </span>
                  {service.autoAddToNewClients && (
                    <Chip
                      tone="blue"
                      strong
                      title="Auto-added to every new client — clear this before deactivating the service"
                    >
                      ★ default
                    </Chip>
                  )}
                  {!service.active && (
                    <span className="text-[11px] uppercase text-faint">inactive</span>
                  )}
                </div>
                <div>
                  <span className="rounded-(--radius-chip) bg-divider px-2 py-0.5 text-[12px] font-medium">
                    {service.type === "subscription"
                      ? "Subscription"
                      : service.type === "one_time"
                        ? "One-time"
                        : "Internal"}
                  </span>
                </div>
                <div className="text-right text-[#6b7280]">
                  {service.type === "internal" ? "—" : service.clientsCount}
                </div>
                <div
                  className="flex items-center justify-end gap-1 text-right"
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* quiet icon strip: text links here wrapped to two lines and drowned the row.
                      Every icon carries its meaning in the tooltip / aria-label */}
                  {isAdmin && (
                    <>
                      <IconButton
                        label="Edit service"
                        onClick={() => {
                          setEditing(service);
                          setEditorOpen(true);
                        }}
                      >
                        <Pencil size={15} />
                      </IconButton>
                      {/* only an active one-time service can be the catalog default, and it has
                          to be cleared before the service can be deactivated — same rules as a
                          client's default service, so the two controls sit together */}
                      {service.type === "one_time" && service.active && (
                        <IconButton
                          label={
                            service.autoAddToNewClients
                              ? "Default for new clients — click to clear"
                              : "Make default for new clients"
                          }
                          disabled={updateService.isPending}
                          className={cn(
                            service.autoAddToNewClients &&
                              "text-[#2f4fd6] hover:text-[#2f4fd6]", // matches the ★ default chip
                          )}
                          onClick={() =>
                            updateService
                              .mutateAsync({
                                id: service.id,
                                input: { autoAddToNewClients: !service.autoAddToNewClients },
                              })
                              .catch(() => {})
                          }
                        >
                          <Star
                            size={15}
                            fill={service.autoAddToNewClients ? "currentColor" : "none"}
                          />
                        </IconButton>
                      )}
                      <IconButton
                        label={service.active ? "Deactivate service" : "Activate service"}
                        title={
                          service.autoAddToNewClients
                            ? "Clear the default first — new clients are given this service automatically"
                            : undefined
                        }
                        disabled={updateService.isPending || service.autoAddToNewClients}
                        className="hover:text-danger"
                        onClick={() =>
                          updateService
                            .mutateAsync({
                              id: service.id,
                              input: { active: !service.active },
                            })
                            .catch(() => {})
                        }
                      >
                        <Power size={15} />
                      </IconButton>
                      <IconButton
                        label="Delete service"
                        disabled={deleteService.isPending}
                        className="hover:text-danger"
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
                        <Trash2 size={15} />
                      </IconButton>
                    </>
                  )}
                </div>
              </div>

              {(expanded.has(service.id) || matchedInside(service)) && (
                <ExpandedPanel
                  service={service}
                  isAdmin={isAdmin}
                  onAddTask={() => setTaskModal({ service })}
                  onEditTask={(template) => setTaskModal({ service, template })}
                />
              )}
            </SortableServiceRow>
          ))}
            </SortableContext>
          </DndContext>
        </div>
      )}

      {rowError && <p className="mt-2 text-[12px] text-danger-text">{rowError}</p>}

      {editorOpen && (
        <ServiceEditorModal
          open={editorOpen}
          service={editing}
          presetType={tab === "internal" ? "internal" : undefined}
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
      {service.type !== "internal" && (
        <span className="inline-flex rounded-[5px] bg-[#eef1fb] px-2 py-[3px] text-[12px] font-medium text-[#2f4fd6]">
          💸 {ruleSummary(service)}
        </span>
      )}
      {(() => {
        const total = service.taskTemplates.reduce((sum, t) => sum + (t.estimatedMinutes ?? 0), 0);
        return total > 0 ? (
          <span className="ml-1.5 inline-flex rounded-[5px] bg-divider px-2 py-[3px] text-[12px] font-medium text-ink-700">
            ⏱ ~{total} min planned{service.type === "one_time" ? " / job" : " / period"}
          </span>
        ) : null;
      })()}
      <div className="mt-2 text-[11px] font-medium uppercase tracking-[.4px] text-muted-400">
        {service.type === "one_time" ? "Job presets — for manual tasks (S6)" : "Item tasks"}
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
          {service.type === "one_time" ? "+ Add job preset" : "+ Add task template"}
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
        <span className="inline-flex items-center gap-1">
          <IconButton label="Edit task" onClick={onEdit}>
            <Pencil size={14} />
          </IconButton>
          <IconButton label="Delete task" className="hover:text-danger" onClick={onDelete}>
            <Trash2 size={14} />
          </IconButton>
        </span>
      )}
    </div>
  );
}

// ── Service editor modal ─────────────────────────────────────────────────────

const serviceFormSchema = z.object({
  name: z.string().trim().min(1, "Required").max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  type: z.enum(["subscription", "one_time", "internal"]),
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
  presetType,
  onClose,
}: {
  open: boolean;
  service?: Service;
  presetType?: "internal";
  onClose: () => void;
}) {
  const create = useCreateService();
  const update = useUpdateService();
  const billing = normalizedBilling(service);
  // internal = firm-internal recurring tasks (no client, no billing) → a stripped-down editor
  const isInternal = service?.type === "internal" || presetType === "internal";

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
      type: service?.type ?? presetType ?? "subscription",
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
    // internal services never bill — send only identity fields
    if (isInternal) {
      try {
        const input = { name: values.name, color: values.color, type: "internal" as const };
        if (service) await update.mutateAsync({ id: service.id, input });
        else await create.mutateAsync(input);
        onClose();
      } catch {
        /* surfaced via serverError below */
      }
      return;
    }
    // the catalog default is set from the row (Make/Clear default), never from this editor —
    // one way to change it, and saving unrelated fields can never re-assert or steal it
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
      title={
        isInternal
          ? service
            ? "Edit internal category"
            : "New internal category"
          : service
            ? "Edit service"
            : "New service"
      }
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
        <FormField
          label={isInternal ? "Category name" : "Service name"}
          htmlFor="s-name"
          error={errors.name?.message}
        >
          <Input
            id="s-name"
            // the name is the first thing you type — open the modal and start typing
            autoFocus
            placeholder={isInternal ? "e.g. Compliance" : "e.g. Bookkeeping"}
            error={!!errors.name}
            {...register("name")}
          />
        </FormField>

        {!isInternal && (
          <div>
            <Label>Type</Label>
            <Segmented
              value={type === "internal" ? "subscription" : type}
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
        )}

        {isInternal && (
          <p className="rounded-(--radius-field) bg-[#f7f8fa] px-3 py-2 text-[12px] text-muted">
            Internal category — recurring firm-internal tasks, no client and no billing. Add task
            templates to it (rhythm, deadline, checklist, assignees) below after saving.
          </p>
        )}

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

        {!isInternal && (
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
            <span>Invoice overdue after</span>
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
          {/* Both are REFERENCE — true, worth knowing once, and not worth two paragraphs under
              every visit to this form. The rule above them stays on the page: it corrects a
              misreading at the moment of choosing, which an icon cannot do. */}
          <p className="mt-2 flex items-center gap-1.5 text-[12px] text-faint">
            Prices and rhythm
            <InfoHint label="How the price and the rhythm are used">
              The expected price prefills the per-client form — the final price is set when the
              service is added to a client. Work rhythm and planned time live on the item&apos;s
              task templates: expand the row and use “+ Add task template”.
            </InfoHint>
          </p>
        </div>
        )}

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
    defaultChecklist: z.array(z.string()),
    description: z.string(),
    defaultAssigneeIds: z.array(z.string()),
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
  const { data: users } = useUsers();
  // one-time service = job presets: always "once", no rhythm (self-heals stray legacy rows)
  const isOneTime = service.type === "one_time";
  // internal templates also carry a description + default assignees (seeded onto generated tasks)
  const isInternal = service.type === "internal";
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
      periodicity: isOneTime ? "once" : (template?.periodicity ?? "monthly"),
      dayOfPeriod: isOneTime ? null : template ? template.dayOfPeriod : 1,
      monthOfPeriod: isOneTime ? null : (template?.monthOfPeriod ?? null),
      deadlineOffsetDays: template?.deadlineOffsetDays ?? null,
      estimatedMinutes: template?.estimatedMinutes ?? null,
      defaultChecklist: template?.defaultChecklist ?? [],
      description: template?.description ?? "",
      defaultAssigneeIds: template?.defaultAssigneeIds ?? [],
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
    // drop blank steps left in the checklist editor
    const input = {
      ...values,
      defaultChecklist: values.defaultChecklist.map((s) => s.trim()).filter(Boolean),
      description: values.description.trim() || null,
    };
    try {
      if (template) {
        await update.mutateAsync({ serviceId: service.id, templateId: template.id, input });
      } else {
        await add.mutateAsync({ serviceId: service.id, input: { ...input, billable: true } });
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
      title={`${template ? "Edit" : "New"} ${isOneTime ? "job preset" : "task template"} — “${service.name}”`}
      open={open}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="template-form" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : template ? "Save" : "Add template"}
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
          oneTime={isOneTime}
        />

        {isInternal && (
          <div>
            <Label>Description (seeded onto each generated task)</Label>
            <Textarea
              className="h-[70px]"
              placeholder="What this internal task is about…"
              {...register("description")}
            />
          </div>
        )}

        <div>
          <div className="mb-1.5 block text-[12px] font-medium text-ink-700">
            Default checklist{" "}
            <span className="font-normal text-muted">
              {isInternal ? "— seeded onto each generated task" : "— seeded onto each task; per-client override on the subscription"}
            </span>
          </div>
          <ChecklistEditor
            value={watch("defaultChecklist")}
            onChange={(next) => setValue("defaultChecklist", next, { shouldDirty: true })}
          />
        </div>

        {isInternal && (
          <div>
            <Label>Assignees (optional — who these tasks go to)</Label>
            <AssigneePicker
              users={users ?? []}
              selected={(id) => watch("defaultAssigneeIds").includes(id)}
              onToggle={(id) => {
                const cur = watch("defaultAssigneeIds");
                setValue(
                  "defaultAssigneeIds",
                  cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
                  { shouldDirty: true },
                );
              }}
            />
            {(users ?? []).length === 0 && (
              <span className="text-[12px] text-faint">No team members yet.</span>
            )}
          </div>
        )}
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
      </form>
    </Modal>
  );
}

/**
 * One catalog row, draggable by its handle.
 *
 * The handle exists because the row is also a BUTTON — clicking it expands the service — and a
 * whole-row drag would fight that: every attempt to expand would start a drag and every drag would
 * end in an expand. Non-admins get the row and no handle at all.
 */
function SortableServiceRow({
  id,
  draggable,
  children,
}: {
  id: string;
  draggable: boolean;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !draggable,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("relative", isDragging && "z-10 opacity-80")}
    >
      {draggable && (
        <button
          type="button"
          aria-label="Drag to reorder"
          {...attributes}
          {...listeners}
          className="absolute left-1 top-3.5 z-10 cursor-grab text-[#c7ccd3] hover:text-muted active:cursor-grabbing"
        >
          <GripVertical size={14} />
        </button>
      )}
      {children}
    </div>
  );
}

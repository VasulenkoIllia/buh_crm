import type {
  MoveServiceInput,
  CreateServiceInput,
  CreateTaskTemplateInput,
  UpdateServiceInput,
  UpdateTaskTemplateInput,
} from "@shared/schema/catalog.js";
import { billingRuleValid, defaultTriggerFor, rhythmValid } from "@shared/schema/catalog.js";
import { ConflictError, NotFoundError, ValidationError } from "../../core/errors.js";
import * as repo from "./catalog.repository.js";

/** Default chip palette (design tokens) — auto-assigned round-robin when no color is picked. */
const PALETTE = ["#2f4fd6", "#7a4fd6", "#1f7a8c", "#b5651d", "#c23434", "#1f8f3a", "#6b7280"];

export function toServiceDto(service: repo.ServiceRecord) {
  return {
    id: service.id,
    name: service.name,
    color: service.color,
    type: service.type,
    defaultAmount: service.defaultAmount,
    invoiceTrigger: service.invoiceTrigger,
    invoiceDay: service.invoiceDay,
    dueDays: service.dueDays,
    active: service.active,
    autoAddToNewClients: service.autoAddToNewClients,
    order: service.order,
    clientsCount: new Set(service.subscriptions.map((s) => s.clientId)).size,
    taskTemplates: service.taskTemplates.map((t) => ({
      id: t.id,
      serviceId: t.serviceId,
      name: t.name,
      periodicity: t.periodicity,
      dayOfPeriod: t.dayOfPeriod,
      monthOfPeriod: t.monthOfPeriod,
      deadlineOffsetDays: t.deadlineOffsetDays,
      estimatedMinutes: t.estimatedMinutes,
      defaultChecklist: (t.defaultChecklist as string[] | null) ?? [],
      description: t.description,
      defaultAssigneeIds: (t.defaultAssigneeIds as string[] | null) ?? [],
      billable: t.billable,
    })),
  };
}

/**
 * Drag a service into place in the catalog. Admin-only, like every other change to it: the order
 * is the firm's, not one reader's, and one read feeds every picker in the app.
 */
export async function moveService(id: string, input: MoveServiceInput) {
  const service = await repo.findService(id);
  if (!service) throw new NotFoundError("Service not found");
  if (input.afterServiceId === id) {
    throw new ValidationError("A service cannot be dropped after itself");
  }
  await repo.moveService(id, input.afterServiceId);
  return listServices();
}

export async function listServices() {
  const services = await repo.listServices();
  return services.map(toServiceDto);
}

export async function createService(input: CreateServiceInput) {
  const existing = await repo.findServiceByName(input.name);
  if (existing) throw new ConflictError("A service with this name already exists");

  const color = input.color ?? PALETTE[(await repo.countServices()) % PALETTE.length];
  // internal services never bill — null out billing fields (a dummy trigger is stored, never used)
  const isInternal = input.type === "internal";
  // create + default-flag in one transaction (the flag unsets any previous holder)
  const service = await repo.createServiceWithDefault(
    {
      name: input.name,
      color,
      type: input.type,
      defaultAmount: isInternal ? null : (input.defaultAmount ?? null),
      invoiceTrigger: input.invoiceTrigger ?? defaultTriggerFor(input.type),
      invoiceDay: isInternal ? null : (input.invoiceDay ?? null),
      dueDays: isInternal ? null : (input.dueDays ?? null),
    },
    isInternal ? false : input.autoAddToNewClients === true,
  );
  return toServiceDto(service!);
}

export async function updateService(id: string, input: UpdateServiceInput) {
  const service = await repo.findService(id);
  if (!service) throw new NotFoundError("Service not found");

  if (input.name) {
    const existing = await repo.findServiceByName(input.name);
    if (existing && existing.id !== id) {
      throw new ConflictError("A service with this name already exists");
    }
  }
  // billing rule must stay valid against the MERGED record (partial PATCHes skip the Zod refine)
  const merged = {
    type: input.type ?? service.type,
    invoiceTrigger: input.invoiceTrigger ?? service.invoiceTrigger,
    invoiceDay: input.invoiceDay !== undefined ? input.invoiceDay : service.invoiceDay,
  };
  if (!billingRuleValid(merged)) {
    throw new ValidationError("Invoice rule doesn't fit the service type");
  }
  // the default-for-new-clients flag is one-time only (merged); it and the field update
  // travel through ONE transaction (unset-others → set), so pull it out of the field data
  const { autoAddToNewClients, ...fields } = input;
  if (autoAddToNewClients === true && merged.type !== "one_time") {
    throw new ValidationError("Only a one-time service can be the default for new clients");
  }
  // Same rules as a CLIENT's default service (2026-07-26): the flag only means something while
  // the service is active — `findDefaultClientService` requires it, so deactivating the default
  // silently stopped new clients getting anything while the ★ kept claiming otherwise.
  const willBeActive = input.active !== undefined ? input.active : service.active;
  if (autoAddToNewClients === true && !willBeActive) {
    throw new ValidationError("Only an active service can be the default for new clients");
  }
  if (input.active === false && service.autoAddToNewClients) {
    throw new ConflictError(
      "This is the default service for new clients — clear that first (or hand it to another service), then deactivate this one",
    );
  }
  // internal never bills — force billing fields null + clear any default flag, regardless of what
  // was passed (mirror createService), so a flip to internal can't leave stale billing/★ behind
  if (merged.type === "internal") {
    fields.defaultAmount = null;
    fields.invoiceDay = null;
    fields.dueDays = null;
  }
  const flag = merged.type === "internal" ? false : autoAddToNewClients;
  const updated = await repo.updateServiceWithDefault(id, fields, flag);
  return toServiceDto(updated!);
}

/**
 * Hard delete — allowed only when NO client uses the service (no subscriptions,
 * even stopped ones; no category chips; no People links). Otherwise → deactivate.
 */
export async function removeService(id: string) {
  const service = await repo.findService(id);
  if (!service) throw new NotFoundError("Service not found");
  const usage = await repo.countServiceUsage(id);
  if (
    usage.subscriptions > 0 ||
    usage.people > 0 ||
    usage.tasks > 0 ||
    usage.invoices > 0
  ) {
    throw new ConflictError(
      "This service has history (subscriptions incl. stopped, people, generated tasks, or invoices) — deactivate it instead of deleting",
    );
  }
  await repo.deleteService(id); // task templates cascade; lead references clear to null
  return { ok: true as const };
}

// ── task templates ───────────────────────────────────────────────────────────

export async function addTemplate(serviceId: string, input: CreateTaskTemplateInput) {
  const service = await repo.findService(serviceId);
  if (!service) throw new NotFoundError("Service not found");
  // one-time services hold JOB PRESETS (deadline + planned time) — no rhythm to repeat
  if (service.type === "one_time" && input.periodicity !== "once") {
    throw new ValidationError("One-time services hold job presets — no repeat rhythm (use once)");
  }
  await repo.createTemplate(serviceId, {
    name: input.name,
    periodicity: input.periodicity,
    dayOfPeriod: input.dayOfPeriod ?? null,
    monthOfPeriod: input.monthOfPeriod ?? null,
    deadlineOffsetDays: input.deadlineOffsetDays ?? null,
    estimatedMinutes: input.estimatedMinutes ?? null,
    defaultChecklist: input.defaultChecklist ?? [],
    description: input.description ?? null,
    defaultAssigneeIds: input.defaultAssigneeIds ?? [],
    billable: input.billable,
  });
  return toServiceDto((await repo.findService(serviceId))!);
}

export async function updateTemplate(
  serviceId: string,
  templateId: string,
  input: UpdateTaskTemplateInput,
) {
  const service = await repo.findService(serviceId);
  const template = await repo.findTemplate(serviceId, templateId);
  if (!service || !template) throw new NotFoundError("Task template not found");
  // rhythm must stay valid against the MERGED row (partial PATCH skips the Zod refine)
  const merged = {
    periodicity: input.periodicity ?? template.periodicity,
    dayOfPeriod: input.dayOfPeriod !== undefined ? input.dayOfPeriod : template.dayOfPeriod,
    monthOfPeriod:
      input.monthOfPeriod !== undefined ? input.monthOfPeriod : template.monthOfPeriod,
  };
  if (!rhythmValid(merged)) {
    throw new ValidationError("Rhythm day/month don't fit the frequency");
  }
  // one-time services hold job presets — no rhythm to repeat
  if (service.type === "one_time" && merged.periodicity !== "once") {
    throw new ValidationError("One-time services hold job presets — no repeat rhythm (use once)");
  }
  await repo.updateTemplate(templateId, input);
  return toServiceDto((await repo.findService(serviceId))!);
}

export async function removeTemplate(serviceId: string, templateId: string) {
  const template = await repo.findTemplate(serviceId, templateId);
  if (!template) throw new NotFoundError("Task template not found");
  await repo.deleteTemplate(templateId);
  return toServiceDto((await repo.findService(serviceId))!);
}

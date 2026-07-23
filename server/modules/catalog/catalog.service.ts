import type {
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
      defaultAssigneeId: t.defaultAssigneeId,
      billable: t.billable,
    })),
  };
}

export async function listServices() {
  const services = await repo.listServices();
  return services.map(toServiceDto);
}

export async function createService(input: CreateServiceInput) {
  const existing = await repo.findServiceByName(input.name);
  if (existing) throw new ConflictError("A service with this name already exists");

  const color = input.color ?? PALETTE[(await repo.countServices()) % PALETTE.length];
  const service = await repo.createService({
    name: input.name,
    color,
    type: input.type,
    defaultAmount: input.defaultAmount ?? null,
    invoiceTrigger: input.invoiceTrigger ?? defaultTriggerFor(input.type),
    invoiceDay: input.invoiceDay ?? null,
    dueDays: input.dueDays ?? null,
  });
  return toServiceDto(service);
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
  return toServiceDto(await repo.updateService(id, input));
}

/**
 * Hard delete — allowed only when NO client uses the service (no subscriptions,
 * even stopped ones; no category chips; no People links). Otherwise → deactivate.
 */
export async function removeService(id: string) {
  const service = await repo.findService(id);
  if (!service) throw new NotFoundError("Service not found");
  const usage = await repo.countServiceUsage(id);
  if (usage.subscriptions > 0 || usage.categories > 0 || usage.people > 0) {
    throw new ConflictError(
      "This service is used by clients (subscriptions incl. stopped, category chips or people) — deactivate it instead of deleting",
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

import type {
  CreateServiceInput,
  CreateTaskTemplateInput,
  UpdateServiceInput,
  UpdateTaskTemplateInput,
} from "@shared/schema/catalog.js";
import { ConflictError, NotFoundError } from "../../core/errors.js";
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
    active: service.active,
    clientsCount: new Set(service.subscriptions.map((s) => s.clientId)).size,
    taskTemplates: service.taskTemplates.map((t) => ({
      id: t.id,
      serviceId: t.serviceId,
      name: t.name,
      periodicity: t.periodicity,
      dayOfPeriod: t.dayOfPeriod,
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
    invoiceTrigger: input.invoiceTrigger,
    invoiceDay: input.invoiceDay ?? null,
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
  return toServiceDto(await repo.updateService(id, input));
}

// ── task templates ───────────────────────────────────────────────────────────

export async function addTemplate(serviceId: string, input: CreateTaskTemplateInput) {
  const service = await repo.findService(serviceId);
  if (!service) throw new NotFoundError("Service not found");
  await repo.createTemplate(serviceId, {
    name: input.name,
    periodicity: input.periodicity,
    dayOfPeriod: input.dayOfPeriod ?? null,
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
  const template = await repo.findTemplate(serviceId, templateId);
  if (!template) throw new NotFoundError("Task template not found");
  await repo.updateTemplate(templateId, input);
  return toServiceDto((await repo.findService(serviceId))!);
}

export async function removeTemplate(serviceId: string, templateId: string) {
  const template = await repo.findTemplate(serviceId, templateId);
  if (!template) throw new NotFoundError("Task template not found");
  await repo.deleteTemplate(templateId);
  return toServiceDto((await repo.findService(serviceId))!);
}

import type {
  CreateSourceInput,
  UpdateFirmInput,
  UpdatePriorityInput,
  UpdateSourceInput,
} from "@shared/schema/settings.js";
import type { FirmProfile, User } from "../../generated/prisma/client.js";
import { ConflictError, NotFoundError } from "../../core/errors.js";
import { sweepCron } from "@shared/notifications.js";
import { rememberFirmName } from "../../core/firm.js";
import { rescheduleJob } from "../../core/scheduler.js";
import { deleteFileBytes, saveFileBytes } from "../../core/files.js";
import { ValidationError } from "../../core/errors.js";
import * as repo from "./settings.repository.js";
import { config } from "../../core/config.js";

const MAX_LOGO_SIZE = 5 * 1024 * 1024; // 5 MB
// raster only — no SVG (can carry inline scripts → stored XSS; same rule as avatars)
const LOGO_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export async function getSettings() {
  const [priorities, sources, firm] = await Promise.all([
    repo.listPriorities(),
    repo.listSources(),
    repo.getFirmProfile(),
  ]);
  return { priorities, sources, firm: toFirmDto(firm) };
}

export function toFirmDto(firm: FirmProfile) {
  return {
    name: firm.name,
    logoFileId: firm.logoFileId,
    invoicePrefix: firm.invoicePrefix,
    invoiceCounterDigits: firm.invoiceCounterDigits,
    currency: firm.currency as "USD",
    // from the environment, not the row: one source of truth, the same one the sweeps use
    timezone: config.TZ,
    notifySweepAt: firm.notifySweepAt,
    notifyDeadlineDays: firm.notifyDeadlineDays,
  };
}

/** Priorities: fixed set of 4 — editable (name/color/order/default), no add/remove. */
export async function updatePriority(id: string, input: UpdatePriorityInput) {
  const priority = await repo.findPriority(id);
  if (!priority) throw new NotFoundError("Priority not found");

  const { isDefault, ...rest } = input;
  if (isDefault) {
    await repo.moveDefaultPriority(id);
  }
  if (Object.keys(rest).length > 0) {
    return repo.updatePriority(id, rest);
  }
  return repo.findPriority(id);
}

/** Reorders two priorities atomically (single transaction — no half-applied swap). */
export async function swapPriorities(aId: string, bId: string) {
  const [a, b] = await Promise.all([repo.findPriority(aId), repo.findPriority(bId)]);
  if (!a || !b) throw new NotFoundError("Priority not found");
  await repo.swapPriorityOrders(aId, bId);
  return repo.listPriorities();
}

export async function createSource(input: CreateSourceInput) {
  const existing = await repo.findSourceByName(input.name);
  if (existing) throw new ConflictError("A source with this name already exists");
  const { _max } = await repo.maxSourceOrder();
  return repo.createSource(input.name, (_max.order ?? -1) + 1);
}

export async function updateSource(id: string, input: UpdateSourceInput) {
  if (input.name) {
    const existing = await repo.findSourceByName(input.name);
    if (existing && existing.id !== id) {
      throw new ConflictError("A source with this name already exists");
    }
  }
  return repo.updateSource(id, input);
}

/**
 * Delete a source, but only while nothing records it — otherwise DEACTIVATE, which is what that
 * control is for and what keeps the history.
 *
 * The database is what actually holds the line: both foreign keys are `ON DELETE RESTRICT`, so a
 * source in use cannot be removed even if two requests race. This count exists to turn that
 * refusal into a sentence with numbers in it, because "it is in use" leaves someone hunting.
 *
 * Archived records count. They can be restored, and a restored client has to come back with the
 * source they arrived by.
 */
export async function removeSource(id: string) {
  const source = await repo.findSource(id);
  if (!source) throw new NotFoundError("Source not found");
  const { clients, leads } = await repo.countSourceUsage(id);
  if (clients > 0 || leads > 0) {
    const parts = [
      clients > 0 ? `${clients} client${clients === 1 ? "" : "s"}` : null,
      leads > 0 ? `${leads} lead${leads === 1 ? "" : "s"}` : null,
    ].filter(Boolean);
    throw new ConflictError(
      `“${source.name}” is recorded on ${parts.join(" and ")} (archived included) — deactivate it instead of deleting`,
    );
  }
  await repo.deleteSource(id);
  return { ok: true as const };
}

export async function updateFirm(input: UpdateFirmInput) {
  const firm = await repo.updateFirmProfile(input);
  // letters print this name and read it from memory, so a rename has to say so
  rememberFirmName(firm.name);

  /**
   * The sweep is a running cron task, registered once at boot. Writing the row is not enough —
   * without this the new time would take effect at the next restart, which for a setting somebody
   * just watched themselves save is indistinguishable from it not working.
   *
   * Only when the time actually changed: rescheduling drops and recreates the task, and doing that
   * on every unrelated firm-profile save (a rename, a logo) is churn for nothing.
   */
  if (input.notifySweepAt !== undefined) {
    rescheduleJob("notification-sweep", sweepCron(firm.notifySweepAt));
  }
  return toFirmDto(firm);
}

export async function setLogo(
  actor: User,
  file: { buffer: Buffer; filename: string; mimetype: string },
) {
  if (!LOGO_MIME.includes(file.mimetype)) {
    throw new ValidationError("Logo must be a PNG, JPEG, WebP or GIF image");
  }
  if (file.buffer.byteLength > MAX_LOGO_SIZE) {
    throw new ValidationError("Logo must be 5 MB or smaller");
  }

  const firm = await repo.getFirmProfile();
  const relPath = await saveFileBytes(file.buffer, file.filename);
  const fileRow = await repo.createFileRow({
    name: file.filename,
    size: file.buffer.byteLength,
    mime: file.mimetype,
    path: relPath,
    uploadedById: actor.id,
  });

  const updated = await repo.updateFirmProfile({
    logoFile: { connect: { id: fileRow.id } },
  });
  if (firm.logoFileId) {
    const old = await repo.findFileById(firm.logoFileId);
    if (old) {
      await repo.deleteFileRow(old.id);
      await deleteFileBytes(old.path);
    }
  }
  return toFirmDto(updated);
}

export async function getLogoFile() {
  const firm = await repo.getFirmProfile();
  if (!firm.logoFileId) throw new NotFoundError("No logo");
  const file = await repo.findFileById(firm.logoFileId);
  if (!file) throw new NotFoundError("No logo");
  return file;
}

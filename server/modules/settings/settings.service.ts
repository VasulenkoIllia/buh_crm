import type {
  CreateSourceInput,
  UpdateFirmInput,
  UpdatePriorityInput,
  UpdateSourceInput,
} from "@shared/schema/settings.js";
import type { FirmProfile, User } from "../../generated/prisma/client.js";
import { ConflictError, NotFoundError } from "../../core/errors.js";
import { deleteFileBytes, saveFileBytes } from "../../core/files.js";
import { ValidationError } from "../../core/errors.js";
import * as repo from "./settings.repository.js";

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

/** Sources are deactivated, never deleted — existing records keep their history. */
export async function updateSource(id: string, input: UpdateSourceInput) {
  if (input.name) {
    const existing = await repo.findSourceByName(input.name);
    if (existing && existing.id !== id) {
      throw new ConflictError("A source with this name already exists");
    }
  }
  return repo.updateSource(id, input);
}

export async function updateFirm(input: UpdateFirmInput) {
  return toFirmDto(await repo.updateFirmProfile(input));
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

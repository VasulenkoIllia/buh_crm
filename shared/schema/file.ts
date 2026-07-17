import { z } from "zod";
import { uuid } from "./common.js";

export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB per file

export const fileSchema = z.object({
  id: uuid,
  name: z.string().min(1),
  size: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
  mime: z.string().min(1),
  clientId: uuid.nullable(),
  uploadedById: uuid,
  createdAt: z.iso.datetime(),
});
export type FileMeta = z.infer<typeof fileSchema>;

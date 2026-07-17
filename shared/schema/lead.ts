import { z } from "zod";
import { uuid } from "./common.js";
import { leadOutcome, leadStage } from "./enums.js";

export const leadSchema = z
  .object({
    id: uuid,
    name: z.string().min(1),
    phone: z.string().nullable(),
    email: z.email().nullable(),
    serviceId: uuid.nullable(),
    sourceId: uuid.nullable(),
    description: z.string().nullable(),
    stage: leadStage,
    outcome: leadOutcome,
    convertedClientId: uuid.nullable(),
    createdAt: z.iso.datetime(),
  })
  .refine((lead) => lead.phone !== null || lead.email !== null, {
    message: "At least one of phone or email is required",
  });
export type Lead = z.infer<typeof leadSchema>;

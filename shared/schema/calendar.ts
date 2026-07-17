import { z } from "zod";
import { uuid } from "./common.js";

export const MEETING_DURATION_PRESETS = [15, 30, 45, 60, 90] as const;

export const meetingSchema = z.object({
  id: uuid,
  title: z.string().min(1),
  clientId: uuid.nullable(),
  leadId: uuid.nullable(),
  serviceId: uuid.nullable(),
  startAt: z.iso.datetime(),
  durationMinutes: z.number().int().positive(),
  link: z.url().nullable(),
  description: z.string().nullable(),
  participantIds: z.array(uuid).min(1),
});
export type Meeting = z.infer<typeof meetingSchema>;

import { z } from "zod";
import { uuid } from "./common.js";
import { campaignAudience, campaignSchedule } from "./enums.js";

export const emailTemplateSchema = z.object({
  id: uuid,
  name: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
  active: z.boolean(),
});
export type EmailTemplate = z.infer<typeof emailTemplateSchema>;

export const campaignSchema = z.object({
  id: uuid,
  name: z.string().min(1),
  templateId: uuid,
  audience: campaignAudience,
  schedule: campaignSchedule,
  enabled: z.boolean(),
});
export type Campaign = z.infer<typeof campaignSchema>;

export const reminderSchema = z.object({
  id: uuid,
  clientId: uuid,
  templateId: uuid,
  date: z.iso.datetime(),
  sentAt: z.iso.datetime().nullable(),
});
export type Reminder = z.infer<typeof reminderSchema>;

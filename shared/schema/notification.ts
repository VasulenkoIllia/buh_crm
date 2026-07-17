import { z } from "zod";
import { uuid } from "./common.js";
import { notificationKind } from "./enums.js";

export const notificationSchema = z.object({
  id: uuid,
  userId: uuid,
  kind: notificationKind,
  text: z.string(),
  sub: z.string().nullable(),
  linkType: z.string().nullable(),
  linkId: uuid.nullable(),
  read: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type Notification = z.infer<typeof notificationSchema>;

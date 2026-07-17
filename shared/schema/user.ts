import { z } from "zod";
import { uuid } from "./common.js";
import { userRole, userStatus } from "./enums.js";

export const userSchema = z.object({
  id: uuid,
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.email(),
  role: userRole,
  status: userStatus,
  avatarFileId: uuid.nullable(),
  emailConfirmedAt: z.iso.datetime().nullable(),
  invitedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type User = z.infer<typeof userSchema>;

export const publicUserSchema = userSchema.pick({
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  role: true,
  status: true,
  avatarFileId: true,
});
export type PublicUser = z.infer<typeof publicUserSchema>;

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

// ── Auth & user-management DTOs ──────────────────────────────────────────────

/** Password policy (decision 2026-07-17): length ≥ 8, no composition rules. */
export const password = z.string().min(8, "Password must be at least 8 characters");

export const loginInput = z.object({
  email: z.email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginInput>;

export const acceptInviteInput = z.object({
  token: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  password,
});
export type AcceptInviteInput = z.infer<typeof acceptInviteInput>;

export const forgotPasswordInput = z.object({
  email: z.email(),
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordInput>;

export const resetPasswordInput = z.object({
  token: z.string().min(1),
  password,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordInput>;

export const inviteUserInput = z.object({
  email: z.email(),
  role: userRole,
});
export type InviteUserInput = z.infer<typeof inviteUserInput>;

/** Admin: change role or block/unblock (active ↔ blocked). */
export const updateUserInput = z.object({
  role: userRole.optional(),
  status: z.enum(["active", "blocked"]).optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserInput>;

export const updateProfileInput = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  currentPassword: z.string().min(1).optional(),
  newPassword: password.optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileInput>;

import argon2 from "argon2";
import type { InviteUserInput, UpdateProfileInput, UpdateUserInput } from "@shared/schema/user.js";
import type { User } from "../../generated/prisma/client.js";
import { destroyAllUserSessions, generateToken } from "../../core/auth.js";
import { sendEmail, webOrigin } from "../../core/email.js";
import { ConflictError, NotFoundError, ValidationError } from "../../core/errors.js";
import { deleteFileBytes, saveFileBytes } from "../../core/files.js";
import * as repo from "./users.repository.js";

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_AVATAR_SIZE = 5 * 1024 * 1024; // 5 MB
// raster only — no SVG (can carry inline scripts → stored XSS)
const AVATAR_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export function listUsers() {
  return repo.listUsers();
}

export async function inviteUser(input: InviteUserInput, invitedBy: User) {
  const existing = await repo.findByEmail(input.email);
  if (existing) throw new ConflictError("A user with this email already exists");

  const user = await repo.createInvitedUser(input.email, input.role);
  await sendInviteEmail(user, invitedBy);
  return user;
}

export async function resendInvite(userId: string, invitedBy: User) {
  const user = await repo.findById(userId);
  if (!user) throw new NotFoundError("User not found");
  if (user.status !== "invited") {
    throw new ValidationError("Only invited users can get a new invite");
  }
  await repo.invalidateInviteTokens(userId);
  await sendInviteEmail(user, invitedBy);
  return user;
}

async function sendInviteEmail(user: User, invitedBy: User) {
  // create the token synchronously (so "Resend" works immediately), but DON'T block
  // the request on SMTP — the mail is fire-and-forget and logs its own failures.
  const { raw, hash } = generateToken();
  await repo.createInviteToken(user.id, hash, new Date(Date.now() + INVITE_TOKEN_TTL_MS));
  const inviterName = `${invitedBy.firstName} ${invitedBy.lastName}`.trim() || invitedBy.email;
  void sendEmail("invite", user.email, {
    inviteUrl: `${webOrigin()}/set-password?token=${raw}`,
    invitedBy: inviterName,
  }).catch(() => {
    /* failure already logged inside sendEmail; admin can Resend */
  });
}

/** Admin: change role / block / unblock. Guards against locking yourself out. */
export async function updateUser(id: string, input: UpdateUserInput, actor: User) {
  const user = await repo.findById(id);
  if (!user) throw new NotFoundError("User not found");
  if (user.id === actor.id) {
    throw new ValidationError("You cannot change your own role or status");
  }
  if (input.status && !["active", "blocked"].includes(user.status) && input.status === "active") {
    throw new ValidationError("Invited users become active by accepting the invite");
  }

  const updated = await repo.updateUser(id, input);
  if (input.status === "blocked") {
    // blocking invalidates sessions immediately (spec: users.md)
    await destroyAllUserSessions(id);
  }
  return updated;
}

export async function updateProfile(user: User, input: UpdateProfileInput) {
  const data: { firstName?: string; lastName?: string; passwordHash?: string } = {};
  if (input.firstName) data.firstName = input.firstName;
  if (input.lastName) data.lastName = input.lastName;

  if (input.newPassword) {
    if (!input.currentPassword || !user.passwordHash) {
      throw new ValidationError("Current password is required to set a new one");
    }
    if (!(await argon2.verify(user.passwordHash, input.currentPassword))) {
      throw new ValidationError("Current password is incorrect");
    }
    data.passwordHash = await argon2.hash(input.newPassword);
  }

  return repo.updateUser(user.id, data);
}

export async function setAvatar(
  user: User,
  file: { buffer: Buffer; filename: string; mimetype: string },
) {
  if (!AVATAR_MIME.includes(file.mimetype)) {
    throw new ValidationError("Avatar must be a PNG, JPEG, WebP or GIF image");
  }
  if (file.buffer.byteLength > MAX_AVATAR_SIZE) {
    throw new ValidationError("Avatar must be 5 MB or smaller");
  }

  const relPath = await saveFileBytes(file.buffer, file.filename);
  const fileRow = await repo.createFileRow({
    name: file.filename,
    size: file.buffer.byteLength,
    mime: file.mimetype,
    path: relPath,
    uploadedById: user.id,
  });

  const oldFileId = user.avatarFileId;
  const updated = await repo.updateUser(user.id, {
    avatarFile: { connect: { id: fileRow.id } },
  });
  if (oldFileId) {
    const old = await repo.findFileById(oldFileId);
    if (old) {
      await repo.deleteFileRow(old.id);
      await deleteFileBytes(old.path);
    }
  }
  return updated;
}

export async function getAvatarFile(userId: string) {
  const user = await repo.findById(userId);
  if (!user?.avatarFileId) throw new NotFoundError("No avatar");
  const file = await repo.findFileById(user.avatarFileId);
  if (!file) throw new NotFoundError("No avatar");
  return file;
}

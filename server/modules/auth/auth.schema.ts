import type { User } from "../../generated/prisma/client.js";
import type { PublicUser } from "@shared/schema/user.js";

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    role: user.role,
    status: user.status,
    avatarFileId: user.avatarFileId,
  };
}

// Permission stub — call sites exist from day one; real rules land with the
// full permission matrix (deferred). Roles: admin / user.

export type PermissionAction = "create" | "read" | "update" | "delete" | "manage";

export interface PermissionUser {
  id: string;
  role: "admin" | "user";
}

export function can(
  _user: PermissionUser,
  _action: PermissionAction,
  _resource: string,
): boolean {
  return true; // stub — replaced by the real matrix later
}

import { useState } from "react";
import { cn } from "@/shared/lib/cn";
import { initials } from "@/shared/lib/format";
import type { PublicUser } from "@shared/schema/user";

const SIZES = {
  /** dense rows and board cards */
  xs: "h-[18px] w-[18px] text-[9px]",
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-[12px]",
  lg: "h-16 w-16 text-[20px]",
};

export function UserAvatar({
  user,
  size = "md",
  version,
  className,
}: {
  user: Pick<PublicUser, "id" | "firstName" | "lastName" | "avatarFileId">;
  size?: keyof typeof SIZES;
  /** bump to bust the browser cache after an upload */
  version?: number;
  /** extra classes on either branch — e.g. a ring marking a blocked teammate */
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (user.avatarFileId && !failed) {
    return (
      <img
        src={`/api/users/${user.id}/avatar${version ? `?v=${version}` : ""}`}
        alt={`${user.firstName} ${user.lastName}`}
        onError={() => setFailed(true)}
        className={cn("rounded-full object-cover", SIZES[size], className)}
      />
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full bg-primary/10 font-semibold text-primary-link",
        SIZES[size],
        className,
      )}
    >
      {initials(user)}
    </span>
  );
}

/** A user's display name — one rule, so no surface renders it a different way. */
export const userLabel = (u: { firstName: string; lastName: string }) =>
  `${u.firstName} ${u.lastName}`.trim();

interface StackUser {
  id: string;
  firstName: string;
  lastName: string;
  avatarFileId: string | null;
  status?: string;
}

/**
 * THE assignee row: up to three faces then "+N", every id resolved through the same directory,
 * an unknown one still drawn (initials/"?") rather than dropped. The board card and the Done
 * card had two near-identical copies of this and drifted — the Done one silently rendered no
 * one at all (2026-08-01). One component, so they cannot disagree again.
 */
export function AssigneeAvatars({
  ids,
  team,
  empty = null,
}: {
  ids: string[];
  team: StackUser[];
  /** what to show when nobody is assigned; omit to render nothing */
  empty?: React.ReactNode;
}) {
  if (ids.length === 0) return <>{empty}</>;
  return (
    <span className="flex items-center gap-1">
      {ids.slice(0, 3).map((id) => {
        const u = team.find((x) => x.id === id);
        const blocked = u?.status === "blocked";
        return (
          <span key={id} title={u ? `${userLabel(u)}${blocked ? " (blocked)" : ""}` : id} className="flex">
            <UserAvatar
              user={u ?? { id, firstName: "", lastName: "", avatarFileId: null }}
              size="xs"
              className={cn(blocked && "ring-2 ring-danger")}
            />
          </span>
        );
      })}
      {ids.length > 3 && <span className="text-[11px] text-muted">+{ids.length - 3}</span>}
    </span>
  );
}

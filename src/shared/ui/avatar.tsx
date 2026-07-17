import { useState } from "react";
import { cn } from "@/shared/lib/cn";
import type { PublicUser } from "@shared/schema/user";

const SIZES = { sm: "h-6 w-6 text-[10px]", md: "h-8 w-8 text-[12px]", lg: "h-16 w-16 text-[20px]" };

export function UserAvatar({
  user,
  size = "md",
  version,
}: {
  user: Pick<PublicUser, "id" | "firstName" | "lastName" | "avatarFileId">;
  size?: keyof typeof SIZES;
  /** bump to bust the browser cache after an upload */
  version?: number;
}) {
  const [failed, setFailed] = useState(false);
  const initials =
    `${user.firstName?.[0] ?? ""}${user.lastName?.[0] ?? ""}`.toUpperCase() || "?";

  if (user.avatarFileId && !failed) {
    return (
      <img
        src={`/api/users/${user.id}/avatar${version ? `?v=${version}` : ""}`}
        alt={`${user.firstName} ${user.lastName}`}
        onError={() => setFailed(true)}
        className={cn("rounded-full object-cover", SIZES[size])}
      />
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full bg-primary/10 font-semibold text-primary-link",
        SIZES[size],
      )}
    >
      {initials}
    </span>
  );
}

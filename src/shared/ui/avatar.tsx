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

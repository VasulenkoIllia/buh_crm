import type { ReactNode } from "react";
import { useAuth } from "./auth";

/**
 * **The shell's own data is the firm's data.** The timer, the tray, the firm's name and logo all
 * come from routes the firm's two-factor rule refuses to somebody it is holding back
 * (two-factor.md §6.4), so for them these are not mounted, rather than mounted to fail.
 */
export function WhenCleared({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { user } = useAuth();
  return <>{user?.twoFactor?.mustEnrol ? fallback : children}</>;
}

import { createContext, useContext, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import type { LoginInput, PublicUser } from "@shared/schema/user";
import { api, ApiError } from "@/shared/lib/api";

interface AuthContextValue {
  user: PublicUser | null;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextValue>({ user: null, isLoading: true });

export const ME_QUERY_KEY = ["auth", "me"] as const;

async function fetchMe(): Promise<PublicUser | null> {
  try {
    return await api<PublicUser>("/api/auth/me");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data, isLoading } = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: fetchMe,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return (
    <AuthContext.Provider value={{ user: data ?? null, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginInput) =>
      api<PublicUser>("/api/auth/login", { method: "POST", body: input }),
    onSuccess: (user) => queryClient.setQueryData(ME_QUERY_KEY, user),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: true }>("/api/auth/logout", { method: "POST" }),
    onSuccess: () => {
      queryClient.setQueryData(ME_QUERY_KEY, null);
      queryClient.clear();
    },
  });
}

function FullScreenSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center text-[13px] text-muted">
      Loading…
    </div>
  );
}

/** Route wrapper: everything inside requires a logged-in user. */
export function RequireAuth() {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  if (isLoading) return <FullScreenSpinner />;
  if (!user) return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

/** Route wrapper: admin-only pages (Team, Settings) — non-admins bounce home. */
export function RequireAdmin() {
  const { user } = useAuth();
  if (user?.role !== "admin") return <Navigate to="/" replace />;
  return <Outlet />;
}

/** Route wrapper for auth screens: bounce logged-in users back to the app. */
export function PublicOnly() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <FullScreenSpinner />;
  if (user) return <Navigate to="/" replace />;
  return <Outlet />;
}

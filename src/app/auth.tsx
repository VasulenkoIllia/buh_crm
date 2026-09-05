import { createContext, useContext, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import type { LoginInput, SessionUser } from "@shared/schema/user";
import { GATES, type AccessState, type GateKey } from "@shared/access";
import { api, ApiError } from "@/shared/lib/api";

interface AuthContextValue {
  user: SessionUser | null;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextValue>({ user: null, isLoading: true });

export const ME_QUERY_KEY = ["auth", "me"] as const;

async function fetchMe(): Promise<SessionUser | null> {
  try {
    return await api<SessionUser>("/api/auth/me");
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

/**
 * **What this person may open — a convenience, never the authority.**
 *
 * The server refuses the request whatever the screen believes; hiding a sidebar item or a button
 * only spares somebody a dead end. The distinction matters because the me-query has a five-minute
 * `staleTime`: a person closed out mid-session keeps their sidebar until it refetches, and the
 * screen behind it must fail as "this area was closed" rather than as a generic error.
 *
 * Falls back to `open` while the session is still loading, so the shell does not flash a
 * half-empty sidebar on every reload.
 */
export function useAccess(): (gate: GateKey) => AccessState {
  const { user } = useAuth();
  return (gate: GateKey) => user?.access?.[gate] ?? GATES[gate].defaults[user?.role ?? "admin"];
}

/** `open` — the area is reachable AND writable. */
export function useCanEdit(gate: GateKey): boolean {
  return useAccess()(gate) === "open";
}

/** `open` or `read_only` — the screen is reachable at all. */
export function useCanOpen(gate: GateKey): boolean {
  return useAccess()(gate) !== "closed";
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginInput) =>
      api<SessionUser>("/api/auth/login", { method: "POST", body: input }),
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

/**
 * Route wrapper: the screen behind a closed gate bounces to the dashboard.
 *
 * The server refuses the data regardless; this stops the page from mounting and asking for it, so
 * a person who types a URL for an area they cannot open lands somewhere real rather than on a
 * screen of failed requests.
 */
export function RequireGate({ gate }: { gate: GateKey }) {
  const { user } = useAuth();
  const state = user?.access?.[gate];
  if (user && state === "closed") return <Navigate to="/" replace />;
  return <Outlet />;
}

/** Route wrapper for auth screens: bounce logged-in users back to the app. */
export function PublicOnly() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <FullScreenSpinner />;
  if (user) return <Navigate to="/" replace />;
  return <Outlet />;
}

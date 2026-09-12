import { createContext, useContext, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import type { LoginInput, SessionUser } from "@shared/schema/user";
import type {
  LoginSecondFactorInput,
  TwoFactorChallengeResult,
} from "@shared/schema/two-factor";
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

/** Step one's two answers: the person, signed in — or a challenge, when a code is owed first. */
type LoginResult = SessionUser | TwoFactorChallengeResult;

export function isChallenge(result: LoginResult): result is TwoFactorChallengeResult {
  return "twoFactorRequired" in result && result.twoFactorRequired === true;
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginInput) =>
      api<LoginResult>("/api/auth/login", { method: "POST", body: input }),
    // a challenge is not a session: there is nobody to remember until the code is right
    // (two-factor.md §5.1)
    onSuccess: (result) => {
      if (!isChallenge(result)) queryClient.setQueryData(ME_QUERY_KEY, result);
    },
  });
}

/** Step two: the challenge from step one, and a code from the app or a recovery code. */
export function useLoginSecondFactor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginSecondFactorInput) =>
      api<SessionUser>("/api/auth/login/2fa", { method: "POST", body: input }),
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

/**
 * Route wrapper: everything inside requires a logged-in user.
 *
 * **And the firm's two-factor rule, past its fortnight** (two-factor.md §6.4): somebody it covers
 * who has not turned it on is sent to the one screen that still answers them — their profile's
 * two-factor tab. The server refuses every other request regardless; this only stops a screen of
 * failed requests from being the thing they see.
 */
export function RequireAuth() {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  if (isLoading) return <FullScreenSpinner />;
  if (!user) return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  if (user.twoFactor?.mustEnrol && location.pathname !== "/profile") {
    return <Navigate to="/profile?tab=security" replace />;
  }
  return <Outlet />;
}

/**
 * Route wrapper: the screen behind a closed gate bounces to the dashboard.
 *
 * The server refuses the data regardless; this stops the page from mounting and asking for it, so
 * a person who types a URL for an area they cannot open lands somewhere real rather than on a
 * screen of failed requests.
 */
/**
 * A route may name SEVERAL gates, and opens if any one of them is open.
 *
 * Settings is the case: it holds the firm's own settings behind `settings`, the access table behind
 * `team` and the activity log behind `activity`. A single gate would have made `activity` a switch
 * that does nothing for anybody whose `settings` is closed — which is most of the point of giving
 * the log a gate of its own (activity-log.md §12). The page itself then shows only the tabs that
 * person may open.
 */
export function RequireGate({ gate }: { gate: GateKey | GateKey[] }) {
  const { user } = useAuth();
  const gates = Array.isArray(gate) ? gate : [gate];
  const closed = gates.every((g) => user?.access?.[g] === "closed");
  if (user && closed) return <Navigate to="/" replace />;
  return <Outlet />;
}

/** Route wrapper for auth screens: bounce logged-in users back to the app. */
export function PublicOnly() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <FullScreenSpinner />;
  if (user) return <Navigate to="/" replace />;
  return <Outlet />;
}

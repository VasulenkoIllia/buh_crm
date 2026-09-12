import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  RecoveryCodesResult,
  TwoFactorPolicy,
  TwoFactorSetup,
  TwoFactorStatus,
  TwoFactorTeamOverview,
} from "@shared/schema/two-factor";
import { ME_QUERY_KEY } from "@/app/auth";
import { api } from "@/shared/lib/api";

const TWO_FACTOR_KEY = ["two-factor"] as const;
const STATUS_KEY = [...TWO_FACTOR_KEY, "me"] as const;
const TEAM_KEY = [...TWO_FACTOR_KEY, "team"] as const;

export function useTwoFactorStatus() {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => api<TwoFactorStatus>("/api/two-factor/me"),
  });
}

/**
 * Anything that changes the caller's own second factor also changes their session payload — the
 * `twoFactor` block the shell reads to decide whether they must enrol — so both are refetched.
 */
function useRefreshOwn() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: TWO_FACTOR_KEY });
    void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
  };
}

export function useBeginTwoFactorSetup() {
  return useMutation({
    mutationFn: (password: string) =>
      api<TwoFactorSetup>("/api/two-factor/me/setup", { method: "POST", body: { password } }),
  });
}

export function useConfirmTwoFactor() {
  const refresh = useRefreshOwn();
  return useMutation({
    mutationFn: (code: string) =>
      api<RecoveryCodesResult>("/api/two-factor/me/confirm", {
        method: "POST",
        body: { code },
      }),
    onSuccess: refresh,
  });
}

export function useRegenerateRecoveryCodes() {
  const refresh = useRefreshOwn();
  return useMutation({
    mutationFn: (password: string) =>
      api<RecoveryCodesResult>("/api/two-factor/me/recovery-codes", {
        method: "POST",
        body: { password },
      }),
    onSuccess: refresh,
  });
}

export function useDisableTwoFactor() {
  const refresh = useRefreshOwn();
  return useMutation({
    mutationFn: (input: { password: string; code: string }) =>
      api<TwoFactorStatus>("/api/two-factor/me/disable", { method: "POST", body: input }),
    onSuccess: refresh,
  });
}

// ── the Team screen ──────────────────────────────────────────────────────────

export function useTwoFactorTeam() {
  return useQuery({
    queryKey: TEAM_KEY,
    queryFn: () => api<TwoFactorTeamOverview>("/api/two-factor/team"),
  });
}

export function useSetTwoFactorPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (policy: TwoFactorPolicy) =>
      api<TwoFactorTeamOverview>("/api/two-factor/policy", { method: "PUT", body: { policy } }),
    onSuccess: (overview) => {
      queryClient.setQueryData(TEAM_KEY, overview);
      // the admin changing it may be covered by it too
      void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
  });
}

export function useResetTwoFactor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      api<TwoFactorTeamOverview>(`/api/two-factor/users/${id}/reset`, {
        method: "POST",
        body: { password },
      }),
    onSuccess: (overview) => queryClient.setQueryData(TEAM_KEY, overview),
  });
}

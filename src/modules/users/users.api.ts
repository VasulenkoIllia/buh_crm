import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  InviteUserInput,
  PublicUser,
  SessionUser,
  UpdateProfileInput,
  UpdateUserInput,
} from "@shared/schema/user";
import { ME_QUERY_KEY } from "@/app/auth";
import { api } from "@/shared/lib/api";
import { USERS_KEY } from "@/shared/lib/query-keys";

export function useUsers() {
  return useQuery({
    queryKey: USERS_KEY,
    queryFn: () => api<PublicUser[]>("/api/users"),
  });
}

export function useInviteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: InviteUserInput) =>
      api<PublicUser>("/api/users/invites", { method: "POST", body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: USERS_KEY }),
  });
}

export function useResendInvite() {
  return useMutation({
    mutationFn: (id: string) =>
      api<PublicUser>(`/api/users/${id}/resend-invite`, { method: "POST" }),
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateUserInput }) =>
      api<PublicUser>(`/api/users/${id}`, { method: "PATCH", body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: USERS_KEY }),
  });
}

/**
 * The profile routes answer with the PUBLIC user — name, email, avatar — not the session payload,
 * so what they return is laid over the cached session rather than put in its place. Replacing it
 * used to drop `access` (the sidebar fell back to the registry defaults until the next refetch)
 * and, since two-factor sign-in, `twoFactor` (audit, 2026-09-12).
 */
function useMergeIntoSession() {
  const queryClient = useQueryClient();
  return (user: PublicUser) => {
    queryClient.setQueryData<SessionUser | null>(ME_QUERY_KEY, (session) =>
      session ? { ...session, ...user } : session,
    );
    void queryClient.invalidateQueries({ queryKey: USERS_KEY }); // Team shows the new name/avatar
  };
}

export function useUpdateProfile() {
  const merge = useMergeIntoSession();
  return useMutation({
    mutationFn: (input: UpdateProfileInput) =>
      api<PublicUser>("/api/users/me", { method: "PATCH", body: input }),
    onSuccess: merge,
  });
}

export function useUploadAvatar() {
  const merge = useMergeIntoSession();
  return useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return api<PublicUser>("/api/users/me/avatar", { method: "PUT", formData });
    },
    onSuccess: merge,
  });
}

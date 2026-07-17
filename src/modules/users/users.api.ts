import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  InviteUserInput,
  PublicUser,
  UpdateProfileInput,
  UpdateUserInput,
} from "@shared/schema/user";
import { ME_QUERY_KEY } from "@/app/auth";
import { api } from "@/shared/lib/api";

const USERS_KEY = ["users"] as const;

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

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateProfileInput) =>
      api<PublicUser>("/api/users/me", { method: "PATCH", body: input }),
    onSuccess: (user) => queryClient.setQueryData(ME_QUERY_KEY, user),
  });
}

export function useUploadAvatar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return api<PublicUser>("/api/users/me/avatar", { method: "PUT", formData });
    },
    onSuccess: (user) => queryClient.setQueryData(ME_QUERY_KEY, user),
  });
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateSourceInput,
  FirmProfile,
  Priority,
  SettingsResponse,
  SourceOption,
  UpdateFirmInput,
  UpdatePriorityInput,
  UpdateSourceInput,
} from "@shared/schema/settings";
import { api } from "@/shared/lib/api";

export const SETTINGS_KEY = ["settings"] as const;

export function useSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => api<SettingsResponse>("/api/settings"),
    staleTime: 60_000,
  });
}

function useInvalidateSettings() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
}

export function useUpdatePriority() {
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdatePriorityInput }) =>
      api<Priority>(`/api/settings/priorities/${id}`, { method: "PATCH", body: input }),
    onSuccess: invalidate,
  });
}

export function useCreateSource() {
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: (input: CreateSourceInput) =>
      api<SourceOption>("/api/settings/sources", { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateSource() {
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateSourceInput }) =>
      api<SourceOption>(`/api/settings/sources/${id}`, { method: "PATCH", body: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateFirm() {
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: (input: UpdateFirmInput) =>
      api<FirmProfile>("/api/settings/firm", { method: "PATCH", body: input }),
    onSuccess: invalidate,
  });
}

export function useUploadLogo() {
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return api<FirmProfile>("/api/settings/firm/logo", { method: "PUT", formData });
    },
    onSuccess: invalidate,
  });
}

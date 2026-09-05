import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateSourceInput,
  FirmProfile,
  Priority,
  SettingsResponse,
  SourceOption,
  SwapPrioritiesInput,
  UpdateFirmInput,
  UpdatePriorityInput,
  UpdateSourceInput,
} from "@shared/schema/settings";
import { api } from "@/shared/lib/api";
import { SETTINGS_KEY, SYSTEM_HEALTH_KEY } from "@/shared/lib/query-keys";
import type { JobHealthRow } from "@shared/system-jobs";

/**
 * The System tab's data.
 *
 * Polled every 30 seconds, and that is not for freshness — a nightly job does not change minute to
 * minute. It is so a page left open while somebody restarts the server stops showing a status
 * that was true five minutes ago. `SYSTEM_HEALTH_KEY` is separate from `SETTINGS_KEY` so saving
 * the firm's name does not refetch this, and this refetching does not disturb an open form.
 */
export function useSystemHealth() {
  return useQuery({
    queryKey: SYSTEM_HEALTH_KEY,
    queryFn: () => api<SystemHealthResponse>("/api/settings/system"),
    refetchInterval: 30_000,
  });
}

export interface SystemHealthResponse {
  bootedAt: string;
  now: string;
  jobs: JobHealthRow[];
}

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

export function useSwapPriorities() {
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: (input: SwapPrioritiesInput) =>
      api<Priority[]>("/api/settings/priorities/swap", { method: "PATCH", body: input }),
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

/**
 * Only possible while nothing records the source. The server refuses with the numbers, and the
 * caller shows that sentence — there is no point pre-checking here, since the answer can change
 * between the check and the click.
 */
export function useDeleteSource() {
  const invalidate = useInvalidateSettings();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: true }>(`/api/settings/sources/${id}`, { method: "DELETE" }),
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

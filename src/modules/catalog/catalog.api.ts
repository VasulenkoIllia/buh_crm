import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateServiceInput,
  CreateTaskTemplateInput,
  Service,
  UpdateServiceInput,
  UpdateTaskTemplateInput,
} from "@shared/schema/catalog";
import { api } from "@/shared/lib/api";

export const CATALOG_KEY = ["catalog"] as const;

/** The whole catalog (active + inactive) — dropdowns filter to active themselves. */
export function useCatalog() {
  return useQuery({
    queryKey: CATALOG_KEY,
    queryFn: () => api<Service[]>("/api/catalog"),
    staleTime: 60_000,
  });
}

function useInvalidateCatalog() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: CATALOG_KEY });
}

export function useCreateService() {
  const invalidate = useInvalidateCatalog();
  return useMutation({
    mutationFn: (input: CreateServiceInput) =>
      api<Service>("/api/catalog", { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateService() {
  const invalidate = useInvalidateCatalog();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateServiceInput }) =>
      api<Service>(`/api/catalog/${id}`, { method: "PATCH", body: input }),
    onSuccess: invalidate,
  });
}

export function useDeleteService() {
  const invalidate = useInvalidateCatalog();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: true }>(`/api/catalog/${id}`, { method: "DELETE" }),
    onSettled: invalidate,
  });
}

export function useAddTemplate() {
  const invalidate = useInvalidateCatalog();
  return useMutation({
    mutationFn: ({ serviceId, input }: { serviceId: string; input: CreateTaskTemplateInput }) =>
      api<Service>(`/api/catalog/${serviceId}/tasks`, { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateTemplate() {
  const invalidate = useInvalidateCatalog();
  return useMutation({
    mutationFn: ({
      serviceId,
      templateId,
      input,
    }: {
      serviceId: string;
      templateId: string;
      input: UpdateTaskTemplateInput;
    }) =>
      api<Service>(`/api/catalog/${serviceId}/tasks/${templateId}`, {
        method: "PATCH",
        body: input,
      }),
    onSettled: invalidate,
  });
}

export function useDeleteTemplate() {
  const invalidate = useInvalidateCatalog();
  return useMutation({
    mutationFn: ({ serviceId, templateId }: { serviceId: string; templateId: string }) =>
      api<Service>(`/api/catalog/${serviceId}/tasks/${templateId}`, { method: "DELETE" }),
    onSettled: invalidate,
  });
}

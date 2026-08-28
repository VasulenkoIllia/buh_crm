import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateServiceInput,
  CreateTaskTemplateInput,
  Service,
  UpdateServiceInput,
  UpdateTaskTemplateInput,
  MoveServiceInput,
} from "@shared/schema/catalog";
import { api } from "@/shared/lib/api";
import { applyDrop } from "@/shared/lib/drop-target";
import { CATALOG_KEY } from "@/shared/lib/query-keys";

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

/**
 * Dragging a service into place in the catalog.
 *
 * Optimistic, like the board's drop: without it the row springs back and only settles when the
 * server answers, which reads as a drag that did not take. The whole catalog is one cached list,
 * so the reorder is applied to it exactly as the server will apply it.
 */
export function useMoveService() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: MoveServiceInput }) =>
      api<Service[]>(`/api/catalog/${id}/position`, { method: "PATCH", body: input }),

    onMutate: async ({ id, input }) => {
      await queryClient.cancelQueries({ queryKey: CATALOG_KEY });
      const snapshot = queryClient.getQueryData<Service[]>(CATALOG_KEY);
      queryClient.setQueryData<Service[]>(CATALOG_KEY, (old) => {
        if (!old) return old;
        return applyDrop(old, id, input.afterServiceId, (s) => s.id);
      });
      return { snapshot };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(CATALOG_KEY, ctx.snapshot);
    },
    // the server owns the numbering, and it answers with the whole catalog
    onSuccess: (list) => queryClient.setQueryData(CATALOG_KEY, list),
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

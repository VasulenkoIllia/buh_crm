import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ConvertLeadInput,
  CreateLeadInput,
  Lead,
  LeadList,
  LeadListQuery,
  UpdateLeadInput,
} from "@shared/schema/lead";
import { api } from "@/shared/lib/api";
import { CLIENTS_KEY, LEADS_KEY } from "@/shared/lib/query-keys";

/**
 * The board and the archive are separate queries — each asks the server for its own side of the
 * pipeline rather than pulling every lead the firm ever had and filtering it here.
 */
export function useLeads(scope: LeadListQuery["scope"] = "all") {
  return useQuery({
    queryKey: [...LEADS_KEY, scope],
    queryFn: () => api<LeadList>(`/api/leads?scope=${scope}`),
    placeholderData: (prev) => prev,
  });
}

function useInvalidateLeads() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: LEADS_KEY });
}

export function useCreateLead() {
  const invalidate = useInvalidateLeads();
  return useMutation({
    mutationFn: (input: CreateLeadInput) =>
      api<Lead>("/api/leads", { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateLeadInput }) =>
      api<Lead>(`/api/leads/${id}`, { method: "PATCH", body: input }),
    // optimistic stage move — the card lands instantly, server confirms after.
    // Patches every cached lead list (board / archive / all) so whichever is on screen moves.
    onMutate: async ({ id, input }) => {
      if (!input.stage) return;
      await queryClient.cancelQueries({ queryKey: LEADS_KEY });
      const previous = queryClient.getQueriesData<LeadList>({ queryKey: LEADS_KEY });
      queryClient.setQueriesData<LeadList>({ queryKey: LEADS_KEY }, (list) =>
        list && {
          ...list,
          items: list.items.map((l) => (l.id === id ? { ...l, stage: input.stage! } : l)),
        },
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      for (const [key, data] of context?.previous ?? []) queryClient.setQueryData(key, data);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: LEADS_KEY }),
  });
}

export function useMarkLost() {
  const invalidate = useInvalidateLeads();
  return useMutation({
    mutationFn: (id: string) => api<Lead>(`/api/leads/${id}/mark-lost`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

export function useReopenLead() {
  const invalidate = useInvalidateLeads();
  return useMutation({
    mutationFn: (id: string) => api<Lead>(`/api/leads/${id}/reopen`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

export function useConvertLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ConvertLeadInput }) =>
      api<{ clientId: string; lead: Lead }>(`/api/leads/${id}/convert`, {
        method: "POST",
        body: input,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: LEADS_KEY });
      queryClient.invalidateQueries({ queryKey: CLIENTS_KEY });
    },
  });
}

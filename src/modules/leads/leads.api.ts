import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ConvertLeadInput,
  CreateLeadInput,
  Lead,
  UpdateLeadInput,
} from "@shared/schema/lead";
import { api } from "@/shared/lib/api";

const LEADS_KEY = ["leads"] as const;

export function useLeads() {
  return useQuery({
    queryKey: LEADS_KEY,
    queryFn: () => api<Lead[]>("/api/leads"),
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
    // optimistic stage move — the card lands instantly, server confirms after
    onMutate: async ({ id, input }) => {
      if (!input.stage) return;
      await queryClient.cancelQueries({ queryKey: LEADS_KEY });
      const previous = queryClient.getQueryData<Lead[]>(LEADS_KEY);
      queryClient.setQueryData<Lead[]>(LEADS_KEY, (leads) =>
        leads?.map((l) => (l.id === id ? { ...l, stage: input.stage! } : l)),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(LEADS_KEY, context.previous);
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
      queryClient.invalidateQueries({ queryKey: ["clients"] });
    },
  });
}

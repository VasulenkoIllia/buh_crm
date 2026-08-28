import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ConvertLeadInput,
  CreateLeadInput,
  Lead,
  LeadList,
  LeadListQuery,
  CreateLeadStageInput,
  LeadStageOption,
  MoveLeadInput,
  MoveLeadStageInput,
  UpdateLeadStageInput,
  UpdateLeadInput,
} from "@shared/schema/lead";
import { applyDrop } from "@/shared/lib/drop-target";
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

/**
 * One lead, by id — what `/leads?lead=<id>` resolves through. Not read out of the board list:
 * the link has to open a won or lost lead too, and those aren't on the board.
 */
export function useLead(id: string | null) {
  return useQuery({
    queryKey: [...LEADS_KEY, "one", id],
    queryFn: () => api<Lead>(`/api/leads/${id}`),
    enabled: !!id,
    // "this lead doesn't exist" is a final answer — retrying it only delays saying so (and the
    // retry can sit paused indefinitely if the browser reports itself offline)
    retry: false,
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

/**
 * Editing a lead's fields. NOT its place on the board — that is `useMoveLead`, which carries a
 * position as well as a stage.
 *
 * This used to hold an optimistic stage move, from when the board dragged through here. Its guard
 * was `if (!input.stage) return`, and the edit form has never sent a stage — so once the board
 * moved to its own mutation the whole block could only ever return early (audit, 2026-08-28).
 */
export function useUpdateLead() {
  const invalidate = useInvalidateLeads();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateLeadInput }) =>
      api<Lead>(`/api/leads/${id}`, { method: "PATCH", body: input }),
    onSuccess: invalidate,
  });
}

/**
 * Dragging a lead on the board — its own mutation, because it carries a POSITION as well as a
 * stage, and `useUpdateLead` knows nothing about order.
 *
 * Optimistic in the same shape the tasks board uses: `applyDrop` produces exactly the arrangement
 * the server will make, so the card lands under the cursor and stays there. The two must agree —
 * a client that guesses differently makes the card jump when the refetch lands.
 */
export function useMoveLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: MoveLeadInput }) =>
      api<Lead>(`/api/leads/${id}/position`, { method: "PATCH", body: input }),
    onMutate: async ({ id, input }) => {
      await queryClient.cancelQueries({ queryKey: LEADS_KEY });
      const previous = queryClient.getQueriesData<LeadList>({ queryKey: LEADS_KEY });
      queryClient.setQueriesData<LeadList>({ queryKey: LEADS_KEY }, (list) => {
        /**
         * Every cached lead query shares this prefix — INCLUDING the stages, which are a plain
         * array. Without this guard the updater read `.items` off that array, threw inside
         * `onMutate`, and the whole mutation failed and rolled back: the card opened a gap, went
         * nowhere, and the server never heard about it (2026-08-28).
         */
        if (!list || !Array.isArray((list as Partial<LeadList>).items)) return list;
        const moved = list.items.find((l) => l.id === id);
        if (!moved) return list;
        const landed = { ...moved, stageId: input.stageId };
        const inStage = applyDrop(
          [...list.items.filter((l) => l.id !== id && l.stageId === input.stageId), landed],
          id,
          input.afterLeadId,
          (l) => l.id,
        ).map((l, boardOrder) => ({ ...l, boardOrder }));
        const elsewhere = list.items.filter((l) => l.id !== id && l.stageId !== input.stageId);
        return { ...list, items: [...elsewhere, ...inStage] };
      });
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

/** Archive a lead — a soft delete, not an outcome. `mark-lost` is how a lead is closed. */
export function useArchiveLead() {
  const invalidate = useInvalidateLeads();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/leads/${id}/archive`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

export function useRestoreLead() {
  const invalidate = useInvalidateLeads();
  return useMutation({
    mutationFn: (id: string) => api<Lead>(`/api/leads/${id}/restore`, { method: "POST" }),
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

// ── the pipeline's columns ───────────────────────────────────────────────────

export function useLeadStages() {
  return useQuery({
    queryKey: [...LEADS_KEY, "stages"],
    queryFn: () => api<LeadStageOption[]>("/api/leads/stages"),
  });
}

function useInvalidateStages() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: LEADS_KEY });
}

export function useAddLeadStage() {
  const invalidate = useInvalidateStages();
  return useMutation({
    mutationFn: (input: CreateLeadStageInput) =>
      api<LeadStageOption>("/api/leads/stages", { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

export function useRenameLeadStage() {
  const invalidate = useInvalidateStages();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateLeadStageInput }) =>
      api<LeadStageOption>(`/api/leads/stages/${id}`, { method: "PATCH", body: input }),
    onSuccess: invalidate,
  });
}

export function useDeleteLeadStage() {
  const invalidate = useInvalidateStages();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: true }>(`/api/leads/stages/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

/**
 * Dragging a stage along the board, applied to the cache first — the same reason a card is:
 * without it the column springs back and jumps forward when the refetch lands, which reads as a
 * drag that failed. `applyDrop` is the arrangement the server makes, so the two cannot disagree.
 */
export function useMoveLeadStage() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateStages();
  const key = [...LEADS_KEY, "stages"];
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: MoveLeadStageInput }) =>
      api<LeadStageOption[]>(`/api/leads/stages/${id}/position`, { method: "PATCH", body: input }),
    onMutate: async ({ id, input }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const snapshot = queryClient.getQueryData<LeadStageOption[]>(key);
      if (snapshot) {
        queryClient.setQueryData<LeadStageOption[]>(
          key,
          applyDrop(snapshot, id, input.afterStageId, (s) => s.id).map((s, order) => ({
            ...s,
            order,
          })),
        );
      }
      return { snapshot };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(key, ctx.snapshot);
    },
    onSettled: invalidate,
  });
}

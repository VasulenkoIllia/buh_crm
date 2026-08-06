import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Calendar,
  CalendarQuery,
  CreateMeetingInput,
  Meeting,
  MeetingConflict,
  UpdateMeetingInput,
} from "@shared/schema/calendar";
import { api } from "@/shared/lib/api";
import { CALENDAR_KEY, CLIENTS_KEY, INVOICES_KEY, TASKS_KEY } from "@/shared/lib/query-keys";

type Window = Pick<CalendarQuery, "from" | "to"> & {
  userId?: string;
  clientId?: string;
  meetings?: boolean;
  deadlines?: boolean;
};

/** One read per window: both lanes come back together so the grid draws in a single pass. */
export function useCalendar(w: Window) {
  const params = new URLSearchParams({ from: w.from, to: w.to });
  if (w.userId) params.set("userId", w.userId);
  if (w.clientId) params.set("clientId", w.clientId);
  if (w.meetings === false) params.set("meetings", "false");
  if (w.deadlines === false) params.set("deadlines", "false");
  return useQuery({
    queryKey: [...CALENDAR_KEY, params.toString()],
    queryFn: () => api<Calendar>(`/api/calendar?${params}`),
    placeholderData: (prev) => prev,
  });
}

/**
 * Who is already booked over a proposed slot. Asked live as the form is filled, so it is kept
 * cheap and is simply skipped while the slot is incomplete.
 */
export function useConflicts(args: {
  startAt: string | null;
  durationMinutes: number;
  userIds: string[];
  excludeMeetingId?: string;
}) {
  const ready = !!args.startAt && args.durationMinutes > 0 && args.userIds.length > 0;
  const params = new URLSearchParams({
    startAt: args.startAt ?? "",
    durationMinutes: String(args.durationMinutes),
    userIds: args.userIds.join(","),
    ...(args.excludeMeetingId ? { excludeMeetingId: args.excludeMeetingId } : {}),
  });
  return useQuery({
    queryKey: [...CALENDAR_KEY, "conflicts", params.toString()],
    queryFn: () => api<MeetingConflict[]>(`/api/calendar/conflicts?${params}`),
    enabled: ready,
    // typing "90" into the duration field walks through 9 and 90, and every participant toggle is
    // another slot: without this the form alone can spend a meaningful slice of the global
    // 300-requests-a-minute budget. Answers stay good for a minute; a real change makes a new key.
    staleTime: 60_000,
    // a clash is advisory — refetching it because a window regained focus is noise
    refetchOnWindowFocus: false,
  });
}

/** One meeting by id — what the edit modal reads. */
export function useMeeting(id: string | undefined) {
  return useQuery({
    queryKey: [...CALENDAR_KEY, "one", id],
    queryFn: () => api<Meeting>(`/api/calendar/meetings/${id}`),
    enabled: !!id,
  });
}

export function useMeetingsFor(target: { clientId?: string; leadId?: string }) {
  const key = target.clientId ? `client=${target.clientId}` : `lead=${target.leadId}`;
  return useQuery({
    queryKey: [...CALENDAR_KEY, "for", key],
    queryFn: () => api<Meeting[]>(`/api/calendar/for?${key}`),
    enabled: !!(target.clientId ?? target.leadId),
  });
}

/**
 * A meeting can open a task and, through it, an invoice — so saving one invalidates all three.
 * Missing any of them shows a stale board next to a fresh calendar.
 */
function useInvalidateCalendar() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: CALENDAR_KEY });
    void qc.invalidateQueries({ queryKey: TASKS_KEY });
    void qc.invalidateQueries({ queryKey: INVOICES_KEY });
    void qc.invalidateQueries({ queryKey: CLIENTS_KEY });
  };
}

export function useCreateMeeting() {
  const invalidate = useInvalidateCalendar();
  return useMutation({
    mutationFn: (input: CreateMeetingInput) =>
      api<Meeting>("/api/calendar/meetings", { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateMeeting() {
  const invalidate = useInvalidateCalendar();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateMeetingInput }) =>
      api<Meeting>(`/api/calendar/meetings/${id}`, { method: "PATCH", body: input }),
    onSuccess: invalidate,
  });
}

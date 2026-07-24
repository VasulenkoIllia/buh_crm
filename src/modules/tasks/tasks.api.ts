import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AddTimeEntryInput,
  CreateColumnInput,
  CreateTaskInput,
  Task,
  TaskColumn,
  UpdateColumnInput,
  UpdateTaskInput,
  UpdateTimeEntryInput,
} from "@shared/schema/task";
import { api } from "@/shared/lib/api";

export const TASKS_KEY = ["tasks"] as const;
const TIMER_KEY = ["tasks", "timer"] as const;

export interface TaskListResponse {
  items: Task[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AssigneeInfo {
  id: string;
  firstName: string;
  lastName: string;
  status: "invited" | "pending" | "active" | "blocked";
}

export interface ActiveTimer {
  entryId: string;
  taskId: string;
  taskTitle: string;
  startedAt: string;
}

/** The board fetch — all live tasks; filtering/grouping is client-side. */
export function useTasks() {
  return useQuery({
    queryKey: [...TASKS_KEY, "list"],
    queryFn: () => api<TaskListResponse>("/api/tasks?view=board"),
  });
}

/** A single client's or lead's tasks — the rollup lists on their cards. */
export function useTasksFor(filter: { clientId?: string; leadId?: string }) {
  const key = filter.clientId ? `clientId=${filter.clientId}` : `leadId=${filter.leadId}`;
  return useQuery({
    queryKey: [...TASKS_KEY, "for", key],
    queryFn: () => api<TaskListResponse>(`/api/tasks?view=board&${key}`),
    enabled: !!(filter.clientId || filter.leadId),
  });
}

export function useTaskColumns() {
  return useQuery({
    queryKey: [...TASKS_KEY, "columns"],
    queryFn: () => api<TaskColumn[]>("/api/tasks/columns"),
  });
}

/** Team directory for assignee pickers + rendering names (blocked get a badge). */
export function useAssignees() {
  return useQuery({
    queryKey: [...TASKS_KEY, "assignees"],
    queryFn: () => api<AssigneeInfo[]>("/api/tasks/assignees"),
    staleTime: 5 * 60 * 1000,
  });
}

function useInvalidateTasks() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: TASKS_KEY });
}

export function useCreateTask() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => api<Task>("/api/tasks", { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateTask() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTaskInput }) =>
      api<Task>(`/api/tasks/${id}`, { method: "PATCH", body: input }),
    onSuccess: invalidate,
  });
}

export function useSetSubtasks() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: ({ id, subtasks }: { id: string; subtasks: { text: string; done: boolean }[] }) =>
      api<Task>(`/api/tasks/${id}/subtasks`, { method: "PUT", body: { subtasks } }),
    onSuccess: invalidate,
  });
}

export function useArchiveTask() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/tasks/${id}/archive`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

// ── columns ──────────────────────────────────────────────────────────────────

export function useAddColumn() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: (input: CreateColumnInput) =>
      api<TaskColumn>("/api/tasks/columns", { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateColumn() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateColumnInput }) =>
      api<TaskColumn>(`/api/tasks/columns/${id}`, { method: "PATCH", body: input }),
    onSuccess: invalidate,
  });
}

export function useDeleteColumn() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/tasks/columns/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

// ── timer ────────────────────────────────────────────────────────────────────

export function useActiveTimer() {
  return useQuery({
    queryKey: TIMER_KEY,
    queryFn: () => api<ActiveTimer | null>("/api/tasks/timer/active"),
    refetchInterval: 60_000, // elapsed ticks client-side; this catches cross-tab changes
  });
}

function useInvalidateTimerAndTasks() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: TASKS_KEY });
    void queryClient.invalidateQueries({ queryKey: TIMER_KEY });
  };
}

export function useStartTimer() {
  const invalidate = useInvalidateTimerAndTasks();
  return useMutation({
    mutationFn: (input: { taskId: string; closeComment?: string }) =>
      api<ActiveTimer>("/api/tasks/timer/start", { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

export function useStopTimer() {
  const invalidate = useInvalidateTimerAndTasks();
  return useMutation({
    mutationFn: (input: { comment: string }) =>
      api<{ ok: true; taskId: string }>("/api/tasks/timer/stop", { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

// ── admin time management ────────────────────────────────────────────────────

export function useAddTimeEntry() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: ({ taskId, input }: { taskId: string; input: AddTimeEntryInput }) =>
      api<Task>(`/api/tasks/${taskId}/time`, { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateTimeEntry() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: ({ entryId, input }: { entryId: string; input: UpdateTimeEntryInput }) =>
      api<Task>(`/api/tasks/time/${entryId}`, { method: "PATCH", body: input }),
    onSuccess: invalidate,
  });
}

export function useDeleteTimeEntry() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: (entryId: string) => api<Task>(`/api/tasks/time/${entryId}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

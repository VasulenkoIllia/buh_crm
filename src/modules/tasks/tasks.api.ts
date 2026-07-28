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
import { CLIENTS_KEY, INVOICES_KEY, TASKS_KEY } from "@/shared/lib/query-keys";

const TIMER_KEY = [...TASKS_KEY, "timer"] as const;

export interface TaskListResponse {
  /** board only: more matching work exists than the board renders */
  truncated?: boolean;
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
  /** null = no avatar uploaded; the card falls back to initials */
  avatarFileId: string | null;
}

export interface ActiveTimer {
  entryId: string;
  taskId: string;
  taskTitle: string;
  startedAt: string;
}

/** What the Tasks screen is asking for. Every one of these is answered by SQL. */
export interface TaskQuery {
  /** open work (the board) or completed work (the Done view) */
  status: "open" | "done";
  /** board = grouped into columns, capped; table = a real page of results */
  view: "board" | "table";
  /** only work whose deadline day has passed */
  overdue?: boolean;
  /** Done view: how many days back to include (undefined = everything ever completed) */
  doneWithinDays?: number;
  assigneeId?: string;
  /** the target filter — a task belongs to one or the other, so only one is ever set */
  clientId?: string;
  leadId?: string;
  page?: number;
  pageSize?: number;
}

/**
 * The Tasks screen's fetch. Filters travel to the SERVER — a chip must search all the work,
 * not just the rows this page happened to load — and the table pages through the full set
 * while the board takes one capped slice and says so (`truncated`).
 */
export function useTasks(query: TaskQuery) {
  const params = new URLSearchParams({ view: query.view, status: query.status });
  if (query.overdue) params.set("overdue", "true");
  if (query.doneWithinDays) params.set("doneWithinDays", String(query.doneWithinDays));
  if (query.assigneeId) params.set("assigneeId", query.assigneeId);
  if (query.clientId) params.set("clientId", query.clientId);
  if (query.leadId) params.set("leadId", query.leadId);
  if (query.view === "table") {
    params.set("page", String(query.page ?? 1));
    params.set("pageSize", String(query.pageSize ?? TABLE_PAGE_SIZE));
  }
  return useQuery({
    queryKey: [...TASKS_KEY, "list", params.toString()],
    queryFn: () => api<TaskListResponse>(`/api/tasks?${params}`),
    placeholderData: (prev) => prev,
  });
}

export const TABLE_PAGE_SIZE = 50;

/** Every client and lead with live work — the option list behind the board's target filter. */
export function useTaskTargets() {
  return useQuery({
    queryKey: [...TASKS_KEY, "targets"],
    queryFn: () => api<TaskTargetInfo[]>("/api/tasks/targets"),
    staleTime: 60_000,
  });
}

export interface TaskTargetInfo {
  id: string;
  name: string;
  kind: "client" | "lead";
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


/**
 * Creating or completing a billable one-time job ISSUES AN INVOICE server-side, which moves the
 * client's debt. Those two mutations therefore refresh billing as well — otherwise the Billing
 * screen and the client card keep showing yesterday's numbers.
 */
function useInvalidateTasksAndBilling() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: TASKS_KEY });
    void queryClient.invalidateQueries({ queryKey: INVOICES_KEY });
    void queryClient.invalidateQueries({ queryKey: CLIENTS_KEY });
  };
}

export function useCreateTask() {
  const invalidate = useInvalidateTasksAndBilling();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => api<Task>("/api/tasks", { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateTask() {
  const invalidate = useInvalidateTasksAndBilling();
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

export function useAddComment() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      api<Task>(`/api/tasks/${id}/comments`, { method: "POST", body: { body } }),
    onSuccess: invalidate,
  });
}

export function useDeleteComment() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: (commentId: string) =>
      api<Task>(`/api/tasks/comments/${commentId}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

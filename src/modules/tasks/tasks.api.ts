import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AddTimeEntryInput,
  CreateColumnInput,
  CreateTaskInput,
  Task,
  TaskColumn,
  MoveColumnInput,
  UpdateColumnInput,
  MoveTaskInput,
  UpdateTaskInput,
  UpdateTimeEntryInput,
} from "@shared/schema/task";
import { api } from "@/shared/lib/api";
import { applyDrop } from "@/shared/lib/drop-target";
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
  /**
   * "all" is the Archive screen's read. The board never asks for it — archived work is done or
   * cancelled by definition, so filtering it by "open" would return an empty screen.
   */
  status: "all" | "open" | "done" | "cancelled";
  /** board = grouped into columns, capped; table = a real page of results */
  view: "board" | "table";
  /** only work whose deadline day has passed */
  overdue?: boolean;
  /** closed views: how many days back (undefined = everything ever) — counted from the column
   *  that view is about, `completedAt` for Done and `cancelledAt` for Cancelled */
  withinDays?: number;
  /** a catalog service, or "none" for work that goes through no service (internal) */
  serviceId?: string;
  assigneeId?: string;
  /** the target filter — a task belongs to one or the other, so only one is ever set */
  clientId?: string;
  leadId?: string;
  /** Archive screen only: archived tasks instead of live ones */
  archived?: boolean;
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
  if (query.archived) params.set("archived", "true");
  if (query.withinDays) params.set("withinDays", String(query.withinDays));
  if (query.serviceId) params.set("serviceId", query.serviceId);
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

/**
 * One task by id — what a `?task=<id>` link falls back to when the loaded view can't answer.
 * The Active board holds only open work, so a link to a COMPLETED task (the header timer bar can
 * be left pointing at one: marking a task done doesn't stop a timer already running on it) found
 * nothing and silently dropped. A missing task is a final answer, so this doesn't retry.
 */
export function useTask(id: string | null) {
  return useQuery({
    queryKey: [...TASKS_KEY, "one", id],
    queryFn: () => api<Task>(`/api/tasks/${id}`),
    enabled: !!id,
    retry: false,
  });
}

/** Every client and lead with live work — the option list behind the board's target filter. */
/**
 * Clients and leads that HAVE work — the board's target filter.
 *
 * Not a picker. Filtering by someone with no tasks would return nothing, so the list is scoped;
 * choosing someone to book a meeting with is the opposite question, and using this there meant a
 * brand new lead could not be selected at all (user, 2026-08-06). For picking, use
 * `ClientLeadSearch`, which searches every live client and lead on the server.
 */
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
    // `entity`, not `board`: unpaginated like the board, but ordered like the list it is — asking
    // for `board` here meant a client's finished work came back ranked by kanban position
    queryFn: () => api<TaskListResponse>(`/api/tasks?view=entity&${key}`),
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

/**
 * Dropping a card — across columns or up and down inside one.
 *
 * Optimistic, and it has to be: without it the card springs back to where it was and only lands
 * once the server answers, which reads as "the drag did not take". The board is rewritten in the
 * cache exactly as the server will rewrite it, and any failure rolls the whole snapshot back.
 */
export function useMoveTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: MoveTaskInput }) =>
      api<Task>(`/api/tasks/${id}/position`, { method: "PATCH", body: input }),

    onMutate: async ({ id, input }) => {
      await queryClient.cancelQueries({ queryKey: TASKS_KEY });

      // ONLY the board's own caches: `["tasks","list",…]` also covers the table, which has its own
      // sort, and the entity rollups, which have their own. Reordering those would be a lie that
      // corrects itself a moment later — the worst kind of flicker.
      const isBoard = (key: readonly unknown[]) =>
        key[0] === "tasks" && key[1] === "list" && String(key[2] ?? "").includes("view=board");

      const snapshot = queryClient.getQueriesData({ predicate: (q) => isBoard(q.queryKey) });
      queryClient.setQueriesData<{ items: Task[] }>(
        { predicate: (q) => isBoard(q.queryKey) },
        (old) => {
          if (!old?.items) return old;
          const moving = old.items.find((t) => t.id === id);
          if (!moving) return old;
          // Rebuild the target column in the order the server will store, then splice the board
          // back together — the list is flat and its order IS the board's order. `applyDrop` is
          // the same arithmetic the server runs, shared so the two cannot drift apart.
          const rest = old.items.filter((t) => t.id !== id);
          const column = rest.filter((t) => t.statusColumnId === input.statusColumnId);
          const others = rest.filter((t) => t.statusColumnId !== input.statusColumnId);
          const landed = { ...moving, statusColumnId: input.statusColumnId };
          const target = applyDrop([...column, landed], id, input.afterTaskId, (t) => t.id);
          return { ...old, items: [...target, ...others] };
        },
      );
      return { snapshot };
    },

    onError: (_err, _vars, context) => {
      for (const [key, data] of context?.snapshot ?? []) queryClient.setQueryData(key, data);
    },

    // the server owns the numbering; settle on its answer either way
    onSettled: () => void queryClient.invalidateQueries({ queryKey: TASKS_KEY }),
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

/** Put an archived task back on the board — refused while its client is archived. */
export function useRestoreTask() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: (id: string) => api<Task>(`/api/tasks/${id}/restore`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

/**
 * Archive many closed tasks at once. Returns what it actually did — `{changed, skipped}` — so the
 * screen can report a partial run instead of implying it archived everything selected.
 */
export function useBulkArchiveTasks() {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn: (taskIds: string[]) =>
      api<{ changed: number; skipped: number }>("/api/tasks/bulk-archive", {
        method: "POST",
        body: { taskIds },
      }),
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

/**
 * Dragging a column into place, applied to the cache first.
 *
 * Optimistic for the same reason a card is: without it the column springs back to where it was and
 * jumps forward when the refetch lands, which reads as a drag that failed. `applyDrop` is the same
 * arrangement the server performs, so the two cannot disagree — and the fixed columns are held at
 * the front here exactly as they are there.
 */
export function useMoveColumn() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateTasks();
  const key = [...TASKS_KEY, "columns"];
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: MoveColumnInput }) =>
      api<TaskColumn[]>(`/api/tasks/columns/${id}/position`, { method: "PATCH", body: input }),
    onMutate: async ({ id, input }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const snapshot = queryClient.getQueryData<TaskColumn[]>(key);
      if (snapshot) {
        const fixed = snapshot.filter((c) => c.isFixed);
        const movable = applyDrop(
          snapshot.filter((c) => !c.isFixed),
          id,
          input.afterColumnId,
          (c) => c.id,
        );
        queryClient.setQueryData<TaskColumn[]>(
          key,
          [...fixed, ...movable].map((c, order) => ({ ...c, order })),
        );
      }
      return { snapshot };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(key, ctx.snapshot);
    },
    onSettled: invalidate,
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

// ── files ────────────────────────────────────────────────────────────────────

export interface TaskFile {
  id: string;
  name: string;
  size: number;
  mime: string;
  createdAt: string;
}

export function useTaskFiles(taskId: string | undefined) {
  return useQuery({
    queryKey: [...TASKS_KEY, "files", taskId],
    queryFn: () => api<TaskFile[]>(`/api/tasks/${taskId}/files`),
    enabled: !!taskId,
  });
}

/**
 * A file uploaded on a job also lands on its client's card — one row carrying both pointers, not a
 * copy. So the CLIENTS caches have to be invalidated too, or that card keeps showing the old list
 * until something else happens to refresh it.
 */
function useInvalidateTaskFiles(taskId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: [...TASKS_KEY, "files", taskId] });
    void queryClient.invalidateQueries({ queryKey: CLIENTS_KEY });
  };
}

export function useUploadTaskFile(taskId: string) {
  const invalidate = useInvalidateTaskFiles(taskId);
  return useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return api<TaskFile>(`/api/tasks/${taskId}/files`, { method: "POST", formData });
    },
    onSuccess: invalidate,
  });
}

export function useDeleteTaskFile(taskId: string) {
  const invalidate = useInvalidateTaskFiles(taskId);
  return useMutation({
    mutationFn: (fileId: string) =>
      api<{ ok: true }>(`/api/tasks/${taskId}/files/${fileId}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

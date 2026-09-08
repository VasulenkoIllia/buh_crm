import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ActivityEventSpec } from "@shared/activity";
import type { ActivityPage, ActivityQuery } from "@shared/schema/activity";
import { api } from "@/shared/lib/api";
import { ACTIVITY_KEY, ACTIVITY_POLICIES_KEY } from "@/shared/lib/query-keys";

/** What the firm has switched off, and what each event is — joined server-side from the registry. */
export interface ActivityPolicyRow {
  action: string;
  enabled: boolean;
  /** false for a key a later build removed — shown rather than hidden, see the service */
  known: boolean;
  spec: ActivityEventSpec | null;
}

type Filters = Partial<Omit<ActivityQuery, "page" | "pageSize">> & {
  page?: number;
  pageSize?: number;
};

function toSearch(filters: Filters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * The feed. `placeholderData` keeps the previous page on screen while the next one loads, so
 * paging and changing a filter do not blank the list and shift the page under the reader's cursor.
 */
export function useActivity(filters: Filters) {
  return useQuery({
    queryKey: [...ACTIVITY_KEY, filters],
    queryFn: () => api<ActivityPage>(`/api/activity${toSearch(filters)}`),
    placeholderData: (previous) => previous,
  });
}

export function useActivityPolicies() {
  return useQuery({
    queryKey: ACTIVITY_POLICIES_KEY,
    queryFn: () => api<ActivityPolicyRow[]>("/api/activity/policies"),
  });
}

export function useSetActivityPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, enabled }: { action: string; enabled: boolean }) =>
      api(`/api/activity/policies/${encodeURIComponent(action)}`, {
        method: "PATCH",
        body: { enabled },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ACTIVITY_POLICIES_KEY }),
  });
}

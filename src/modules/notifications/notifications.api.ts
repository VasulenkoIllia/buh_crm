import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  NotificationTray,
  SetPreferenceInput,
  UpdatePolicyInput,
} from "@shared/schema/notification";
import type { NotificationChannel, RecipientRole } from "@shared/notifications";
import { api } from "@/shared/lib/api";
import { NOTIFICATIONS_KEY } from "@/shared/lib/query-keys";
import { playChime } from "./chime";

const TRAY_KEY = [...NOTIFICATIONS_KEY, "tray"] as const;
const PREFS_KEY = [...NOTIFICATIONS_KEY, "preferences"] as const;
const POLICIES_KEY = [...NOTIFICATIONS_KEY, "policies"] as const;

/** What the profile screen needs per trigger: what is allowed, what the default is, what I chose. */
export interface PreferenceRow {
  trigger: string;
  enabled: boolean;
  mandatory: boolean;
  allowedInApp: boolean;
  allowedEmail: boolean;
  allowedSound: boolean;
  defaultInApp: boolean;
  defaultEmail: boolean;
  defaultSound: boolean;
  /** null = follow the default, which is stored as the ABSENCE of a row */
  inApp: boolean | null;
  email: boolean | null;
  sound: boolean | null;
}

export interface PolicyRow {
  trigger: string;
  enabled: boolean;
  mandatory: boolean;
  roles: RecipientRole[];
  inApp: boolean;
  email: boolean;
  sound: boolean;
  defaultInApp: boolean;
  defaultEmail: boolean;
  defaultSound: boolean;
}

/**
 * The tray polls on the same minute the timer bar does
 * (`src/modules/tasks/tasks.api.ts` — `refetchInterval: 60_000`). One precedent, one cadence:
 * a bell that refreshed faster than the timer would be a second answer to "how live is this app".
 */
export function useNotifications() {
  return useQuery({
    queryKey: TRAY_KEY,
    queryFn: () => api<NotificationTray>("/api/notifications"),
    refetchInterval: 60_000,
  });
}

/**
 * The chime, driven by what the TRAY POLL brings back.
 *
 * Three rules, and each of them is the difference between a useful sound and an infuriating one:
 *
 *  1. **Never on the first load.** Arriving at work to twenty-three unread rows must not play a
 *     sound; the first fetch only establishes what "already seen" means.
 *  2. **One sound per poll, however many rows arrived.** The 07:00 sweep can raise a dozen at
 *     once, and a dozen chimes on the hour is the reason people turn sounds off forever.
 *  3. **Only rows the SERVER marked.** Whether a notification chimes is decided by the firm's
 *     policy and the person's own preference, in `core/notify.ts`, at the moment it is written —
 *     the browser is not a second place where that rule lives.
 *
 * Mounted once, by the tray in the app shell. It reads the same cached query the bell renders, so
 * it costs no extra request.
 */
export function useNotificationChime() {
  const { data } = useNotifications();
  /** ids already accounted for. `null` until the first fetch — see rule 1. */
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!data) return;
    const ids = new Set(data.items.map((n) => n.id));
    if (seen.current === null) {
      seen.current = ids; // the first answer is a baseline, never an event
      return;
    }
    const arrived = data.items.filter((n) => !seen.current!.has(n.id));
    seen.current = ids;
    if (arrived.some((n) => n.sound)) playChime(); // rule 2: `some`, not `forEach`
  }, [data]);
}

function useInvalidateTray() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: TRAY_KEY });
}

export function useDismissNotification() {
  const invalidate = useInvalidateTray();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: true }>(`/api/notifications/${id}/read`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

export function useDismissAllNotifications() {
  const invalidate = useInvalidateTray();
  return useMutation({
    mutationFn: () =>
      api<{ ok: true; count: number }>("/api/notifications/read-all", { method: "POST" }),
    onSuccess: invalidate,
  });
}

export function useMyNotificationPreferences() {
  return useQuery({
    queryKey: PREFS_KEY,
    queryFn: () => api<{ triggers: PreferenceRow[] }>("/api/notifications/preferences"),
  });
}

export function useSetNotificationPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SetPreferenceInput) =>
      api<{ triggers: PreferenceRow[] }>("/api/notifications/preferences", {
        method: "PUT",
        body: input,
      }),
    onSuccess: (data) => {
      // the response IS the new state, so the screen never flickers back through a refetch
      queryClient.setQueryData(PREFS_KEY, data);
    },
  });
}

export function useNotificationPolicies() {
  return useQuery({
    queryKey: POLICIES_KEY,
    queryFn: () => api<{ triggers: PolicyRow[] }>("/api/notifications/policies"),
  });
}

export function useUpdateNotificationPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ trigger, ...input }: UpdatePolicyInput & { trigger: string }) =>
      api<{ triggers: PolicyRow[] }>(`/api/notifications/policies/${trigger}`, {
        method: "PATCH",
        body: input,
      }),
    onSuccess: (data) => queryClient.setQueryData(POLICIES_KEY, data),
  });
}

export type { NotificationChannel };

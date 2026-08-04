import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Client,
  ClientListQuery,
  ClientSecret,
  ClientSecretInput,
  CreateClientInput,
  CreateSubscriptionInput,
  UpdateClientInput,
  PauseSubscriptionInput,
  ResumeSubscriptionInput,
  UnlockSecretsInput,
  UpdateSubscriptionInput,
} from "@shared/schema/client";
import { api } from "@/shared/lib/api";
import { CATALOG_KEY, CLIENTS_KEY } from "@/shared/lib/query-keys";

export interface ClientListResponse {
  items: Client[];
  total: number;
  page: number;
  pageSize: number;
  counts: { regular: number; one_time: number };
}

export interface ClientFile {
  id: string;
  name: string;
  size: number;
  mime: string;
  createdAt: string;
}


export function useClients(query: Partial<ClientListQuery>, opts?: { enabled?: boolean }) {
  const params = new URLSearchParams();
  if (query.tab) params.set("tab", query.tab);
  if (query.search) params.set("search", query.search);
  if (query.page) params.set("page", String(query.page));
  if (query.pageSize) params.set("pageSize", String(query.pageSize));
  return useQuery({
    queryKey: [...CLIENTS_KEY, "list", params.toString()],
    queryFn: () => api<ClientListResponse>(`/api/clients?${params}`),
    placeholderData: (prev) => prev,
    enabled: opts?.enabled ?? true,
  });
}

export function useClient(id: string | undefined) {
  return useQuery({
    queryKey: [...CLIENTS_KEY, "one", id],
    queryFn: () => api<Client>(`/api/clients/${id}`),
    enabled: !!id,
  });
}

function useInvalidateClients() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: CLIENTS_KEY });
}

export function useCreateClient() {
  const invalidate = useInvalidateClients();
  return useMutation({
    mutationFn: (input: CreateClientInput) =>
      api<Client>("/api/clients", { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateClient() {
  const invalidate = useInvalidateClients();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateClientInput }) =>
      api<Client>(`/api/clients/${id}`, { method: "PATCH", body: input }),
    onSuccess: invalidate,
  });
}

export function useArchiveClient() {
  const invalidate = useInvalidateClients();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/clients/${id}/archive`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

/** Bring an archived client back. Their services stay paused — resuming one is its own decision. */
export function useRestoreClient() {
  const invalidate = useInvalidateClients();
  return useMutation({
    mutationFn: (id: string) => api<Client>(`/api/clients/${id}/restore`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

export function useClientFiles(clientId: string | undefined) {
  return useQuery({
    queryKey: [...CLIENTS_KEY, "files", clientId],
    queryFn: () => api<ClientFile[]>(`/api/clients/${clientId}/files`),
    enabled: !!clientId,
  });
}

export function useUploadClientFile(clientId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return api<ClientFile>(`/api/clients/${clientId}/files`, { method: "POST", formData });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [...CLIENTS_KEY, "files", clientId] }),
  });
}

export function useDeleteClientFile(clientId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) =>
      api<{ ok: true }>(`/api/clients/${clientId}/files/${fileId}`, { method: "DELETE" }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [...CLIENTS_KEY, "files", clientId] }),
  });
}

// ── subscriptions & categories (S3) ─────────────────────────────────────────

/** Subscriptions change the catalog's clientsCount — refresh both caches. */
function useInvalidateClientsAndCatalog() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: CLIENTS_KEY });
    void queryClient.invalidateQueries({ queryKey: CATALOG_KEY });
  };
}

export function useAddSubscription() {
  const invalidate = useInvalidateClientsAndCatalog();
  return useMutation({
    mutationFn: ({ clientId, input }: { clientId: string; input: CreateSubscriptionInput }) =>
      api<Client>(`/api/clients/${clientId}/subscriptions`, { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateSubscription() {
  const invalidate = useInvalidateClientsAndCatalog();
  return useMutation({
    mutationFn: ({
      clientId,
      subscriptionId,
      input,
    }: {
      clientId: string;
      subscriptionId: string;
      input: UpdateSubscriptionInput;
    }) =>
      api<Client>(`/api/clients/${clientId}/subscriptions/${subscriptionId}`, {
        method: "PATCH",
        body: input,
      }),
    onSuccess: invalidate,
  });
}

/**
 * Pausing and resuming carry a DATE, so they are their own calls rather than an `active` flag —
 * that date is what lets the app answer "was this client served on the 1st" months later, which
 * is what decides both billing and task generation.
 */
export function usePauseSubscription() {
  const invalidate = useInvalidateClientsAndCatalog();
  return useMutation({
    mutationFn: ({
      clientId,
      subscriptionId,
      input,
    }: {
      clientId: string;
      subscriptionId: string;
      input: PauseSubscriptionInput;
    }) =>
      api<Client>(`/api/clients/${clientId}/subscriptions/${subscriptionId}/pause`, {
        method: "POST",
        body: input,
      }),
    onSuccess: invalidate,
  });
}

export function useResumeSubscription() {
  const invalidate = useInvalidateClientsAndCatalog();
  return useMutation({
    mutationFn: ({
      clientId,
      subscriptionId,
      input,
    }: {
      clientId: string;
      subscriptionId: string;
      input: ResumeSubscriptionInput;
    }) =>
      api<Client>(`/api/clients/${clientId}/subscriptions/${subscriptionId}/resume`, {
        method: "POST",
        body: input,
      }),
    onSuccess: invalidate,
  });
}


// ── secrets (S7.5) ───────────────────────────────────────────────────────────

const SECRETS_KEY = (clientId: string) => [...CLIENTS_KEY, clientId, "secrets"] as const;

/** Labels + descriptions only — the value never enters this cache, or any cache. */
export function useClientSecrets(clientId: string) {
  return useQuery({
    queryKey: SECRETS_KEY(clientId),
    queryFn: () => api<ClientSecret[]>(`/api/clients/${clientId}/secrets`),
  });
}

/** How long this user's window on this client has left; null = locked. */
export function useSecretGrant(clientId: string) {
  return useQuery({
    queryKey: [...SECRETS_KEY(clientId), "grant"],
    queryFn: () => api<{ expiresAt: string | null }>(`/api/clients/${clientId}/secrets/grant`),
  });
}

function useInvalidateSecrets(clientId: string) {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: SECRETS_KEY(clientId) });
}

export function useUnlockSecrets(clientId: string) {
  const invalidate = useInvalidateSecrets(clientId);
  return useMutation({
    mutationFn: (input: UnlockSecretsInput) =>
      api<{ expiresAt: string }>(`/api/clients/${clientId}/secrets/unlock`, {
        method: "POST",
        body: input,
      }),
    onSuccess: invalidate,
  });
}

export function useSaveSecret(clientId: string) {
  const invalidate = useInvalidateSecrets(clientId);
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: ClientSecretInput }) =>
      api<ClientSecret[]>(
        id ? `/api/clients/${clientId}/secrets/${id}` : `/api/clients/${clientId}/secrets`,
        { method: id ? "PATCH" : "POST", body: input },
      ),
    onSuccess: invalidate,
  });
}

export function useDeleteSecret(clientId: string) {
  const invalidate = useInvalidateSecrets(clientId);
  return useMutation({
    mutationFn: (id: string) =>
      api<ClientSecret[]>(`/api/clients/${clientId}/secrets/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

/**
 * Fetch a plaintext value. Deliberately NOT a react-query hook: the value must never land in the
 * query cache, where it would sit in memory, survive navigation and show up in devtools. The
 * caller holds it in component state and clears it on a timer.
 */
export const revealSecret = (clientId: string, secretId: string) =>
  api<{ value: string; expiresAt: string }>(
    `/api/clients/${clientId}/secrets/${secretId}/reveal`,
    { method: "POST" },
  );

export interface SecretAuditPage {
  items: { id: string; action: string; label: string | null; byName: string; createdAt: string }[];
  total: number;
  page: number;
  pageSize: number;
}

export const fetchSecretAudit = (clientId: string, page = 1) =>
  api<SecretAuditPage>(`/api/clients/${clientId}/secrets/audit?page=${page}`);

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  MoveSecretsInput,
  SecretFileRow,
  SecretHistoryRow,
  SecretInput,
  SecretRow,
  SecretSearchPage,
  SecretTemplate,
  UnlockVaultInput,
} from "@shared/schema/secrets";
import { api } from "@/shared/lib/api";
import { VAULT_KEY } from "@/shared/lib/query-keys";
import { placePath, type UiPlace } from "./places";

/**
 * Everything the vault reads and writes. One key covers the lot: a save, a move, a delete or a
 * restore changes counts in the tree, a list, the Trash and the search at once, and the screen is
 * small enough that refetching all of it is cheaper than deciding what not to.
 *
 * **A plaintext value never comes through here.** `revealSecret` is a plain function on purpose:
 * react-query would keep what it returns in a cache that survives navigation and shows up in
 * devtools. The window that asks for it holds it in component state and drops it.
 */
const GRANT_KEY = [...VAULT_KEY, "grant"] as const;

export interface VaultOverview {
  personal: number;
  company: number;
  clients: number;
  trash: number;
  clientsOpen: boolean;
}

export interface ClientNode {
  id: string;
  label: string;
  code: number;
  secrets: number;
}

export interface TrashBatch {
  batchId: string;
  deletedAt: string;
  deletedBy: string;
  daysLeft: number;
  items: { id: string; label: string; template: SecretTemplate; place: string }[];
}

export function useInvalidateVault() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: VAULT_KEY });
}

export function useOverview() {
  return useQuery({
    queryKey: [...VAULT_KEY, "overview"],
    queryFn: () => api<VaultOverview>("/api/secrets/overview"),
  });
}

export function useClientNodes(enabled: boolean) {
  return useQuery({
    queryKey: [...VAULT_KEY, "clients"],
    queryFn: () => api<ClientNode[]>("/api/secrets/clients"),
    enabled,
  });
}

export function usePlaceSecrets(place: UiPlace) {
  const path = placePath(place);
  return useQuery({
    queryKey: [...VAULT_KEY, "place", path],
    queryFn: () => api<SecretRow[]>(`/api/secrets/${path}`),
  });
}

export function useTrash() {
  return useQuery({
    queryKey: [...VAULT_KEY, "trash"],
    queryFn: () => api<{ batches: TrashBatch[] }>("/api/secrets/trash"),
  });
}

/** One box over everything the reader may see (§10). Empty query, empty answer, no request. */
export function useSearch(q: string, filters: { place?: string; template?: string }) {
  const params = new URLSearchParams({ q });
  if (filters.place) params.set("place", filters.place);
  if (filters.template) params.set("template", filters.template);
  return useQuery({
    queryKey: [...VAULT_KEY, "search", q, filters.place ?? "", filters.template ?? ""],
    queryFn: () => api<SecretSearchPage>(`/api/secrets/search?${params.toString()}`),
    enabled: q.trim().length > 0,
  });
}

export function useHistory(secretId: string | null) {
  return useQuery({
    queryKey: [...VAULT_KEY, "history", secretId],
    queryFn: () => api<SecretHistoryRow[]>(`/api/secrets/history/${secretId!}`),
    enabled: !!secretId,
  });
}

// ── the window on the whole vault (§6) ───────────────────────────────────────

/** How long this session's window has left; null = locked. One window, the whole vault. */
export function useVaultGrant() {
  return useQuery({
    queryKey: GRANT_KEY,
    queryFn: () => api<{ expiresAt: string | null }>("/api/secrets/grant"),
  });
}

/**
 * **The two mutations that carry plaintext keep it no longer than they run.** react-query stores a
 * mutation's variables in its cache, and `reset()` only lets go of them: the mutation itself stays
 * for `gcTime`, five minutes by default, readable from devtools. Here the variables are the person's
 * own password and a secret's values, so `gcTime: 0` removes the mutation as soon as nothing
 * watches it (review, 2026-09-16; the save's comment said "reset drops them now" since 2026-08-03,
 * and it did not).
 */
export const NOT_KEPT = { gcTime: 0 } as const;

export function useUnlockVault() {
  const queryClient = useQueryClient();
  return useMutation({
    ...NOT_KEPT,
    mutationFn: (input: UnlockVaultInput) =>
      api<{ expiresAt: string }>("/api/secrets/unlock", { method: "POST", body: input }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: GRANT_KEY }),
  });
}

/** Opens every secret field of one entry, and counts as one look in the journal (§6). */
export const revealSecret = (place: UiPlace, secretId: string) =>
  api<{ secret: Record<string, string>; expiresAt: string }>(
    `/api/secrets/${placePath(place)}/${secretId}/reveal`,
    { method: "POST" },
  );

/** A client's Access log: that client's journal rows, newest first, a page at a time (§11). */
export interface SecretAuditPage {
  items: {
    id: string;
    action: string;
    label: string | null;
    byName: string;
    createdAt: string;
  }[];
  total: number;
  page: number;
  pageSize: number;
}

export function useClientAudit(clientId: string, page: number) {
  return useQuery({
    queryKey: [...VAULT_KEY, "audit", clientId, page],
    queryFn: () => api<SecretAuditPage>(`/api/secrets/clients/${clientId}/audit?page=${page}`),
  });
}

// ── a free-form secret's files (§21) ────────────────────────────────────────
// Opening and downloading are plain URLs the browser follows, behind the same five minutes as a
// value; adding and removing answer the secret's files as they are now.

export const secretFileUrl = (fileId: string) => `/api/secrets/files/${fileId}`;
export const secretFileViewUrl = (fileId: string) => `/api/secrets/files/${fileId}/view`;

export function attachSecretFile(secretId: string, file: File) {
  const form = new FormData();
  form.append("file", file);
  return api<SecretFileRow[]>(`/api/secrets/files?secretId=${secretId}`, {
    method: "POST",
    formData: form,
  });
}

export const removeSecretFile = (fileId: string) =>
  api<SecretFileRow[]>(secretFileUrl(fileId), { method: "DELETE" });

// ── writing ─────────────────────────────────────────────────────────────────

export function useSaveSecret(place: UiPlace) {
  const invalidate = useInvalidateVault();
  return useMutation({
    ...NOT_KEPT,
    mutationFn: ({ id, input }: { id?: string; input: SecretInput }) =>
      api<SecretRow[]>(
        id ? `/api/secrets/${placePath(place)}/${id}` : `/api/secrets/${placePath(place)}`,
        { method: id ? "PATCH" : "POST", body: input },
      ),
    onSuccess: invalidate,
  });
}

/**
 * One or several from one place into the Trash as ONE gesture, where they wait thirty days; the
 * answer's `batchId` is what an Undo restores (§9). A plain function because the place is whichever
 * the person acted in, not one the screen knows in advance; the caller refreshes the vault.
 */
export const trashSecrets = (place: UiPlace, ids: string[]) =>
  api<{ deleted: number; batchId: string }>(`/api/secrets/${placePath(place)}/delete`, {
    method: "POST",
    body: { ids },
  });

export function useRestoreBatch() {
  const invalidate = useInvalidateVault();
  return useMutation({
    mutationFn: (batchId: string) =>
      api<{ restored: number }>(`/api/secrets/trash/batches/${batchId}/restore`, {
        method: "POST",
      }),
    onSuccess: invalidate,
  });
}

export function useRestoreSecret() {
  const invalidate = useInvalidateVault();
  return useMutation({
    mutationFn: (secretId: string) =>
      api<{ restored: number }>(`/api/secrets/trash/secrets/${secretId}/restore`, {
        method: "POST",
      }),
    onSuccess: invalidate,
  });
}

/**
 * Out of My secrets or Company, anyone with Secrets; out of a CLIENT, admins only, through the
 * route that says so (§7). The screen picks the path by where the secrets are now.
 */
export function useMoveSecrets(from: UiPlace) {
  const invalidate = useInvalidateVault();
  const path =
    from.kind === "client" ? `clients/${from.clientId}/move-out` : `${placePath(from)}/move`;
  return useMutation({
    mutationFn: (input: MoveSecretsInput) =>
      api<{ moved: number; to: string }>(`/api/secrets/${path}`, {
        method: "POST",
        body: input,
      }),
    onSuccess: invalidate,
  });
}

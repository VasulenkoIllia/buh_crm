import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Client,
  ClientListQuery,
  CreateClientInput,
  UpdateClientInput,
} from "@shared/schema/client";
import { api } from "@/shared/lib/api";

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

const CLIENTS_KEY = ["clients"] as const;

export function useClients(query: Partial<ClientListQuery>) {
  const params = new URLSearchParams();
  if (query.tab) params.set("tab", query.tab);
  if (query.search) params.set("search", query.search);
  if (query.page) params.set("page", String(query.page));
  if (query.pageSize) params.set("pageSize", String(query.pageSize));
  return useQuery({
    queryKey: [...CLIENTS_KEY, "list", params.toString()],
    queryFn: () => api<ClientListResponse>(`/api/clients?${params}`),
    placeholderData: (prev) => prev,
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

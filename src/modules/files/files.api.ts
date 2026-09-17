import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  AttachmentGroup,
  ClientFilesDetail,
  ClientFilesNode,
  EnsuredFolder,
  FileRow,
  FilesOverview,
  FolderListing,
  FolderNode,
  FolderRow,
  MoveInput,
  MoveResult,
  RestoreResult,
  SearchPage,
  SearchQuery,
  TrashPage,
  TrashResult,
} from "@shared/schema/files";
import type { FileZone } from "@shared/library";
import { ApiError, api } from "@/shared/lib/api";
import { CLIENTS_KEY, FILES_KEY, TASKS_KEY } from "@/shared/lib/query-keys";
import { areaBase, placeBase, placeKey, type UiPlace } from "./places";

/**
 * The library's reads and writes (files.md §18). Every write refreshes everything the library
 * touches: its own lists and totals, a client card's list and counts, and a task's files, since a
 * file on a task is the same row wherever it is shown.
 */
export function refreshLibrary(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: FILES_KEY }),
    queryClient.invalidateQueries({ queryKey: CLIENTS_KEY }),
    queryClient.invalidateQueries({ queryKey: [...TASKS_KEY, "files"] }),
  ]);
}

// ── reads ────────────────────────────────────────────────────────────────────

export function useOverview(enabled = true) {
  return useQuery({
    queryKey: [...FILES_KEY, "overview"],
    queryFn: () => api<FilesOverview>("/api/files/overview"),
    enabled,
  });
}

export function useClientNodes(enabled: boolean) {
  return useQuery({
    queryKey: [...FILES_KEY, "clients"],
    queryFn: () => api<ClientFilesNode[]>("/api/files/clients"),
    enabled,
  });
}

export function useClientDetail(clientId: string | null) {
  return useQuery({
    queryKey: [...FILES_KEY, "client", clientId],
    queryFn: () => api<ClientFilesDetail>(`/api/files/clients/${clientId}`),
    enabled: !!clientId,
  });
}

export function useFolderTree(place: UiPlace | null) {
  return useQuery({
    queryKey: [...FILES_KEY, "folders", place ? placeKey(place) : null],
    queryFn: () => api<FolderNode[]>(`${placeBase(place as UiPlace)}/folders`),
    enabled: !!place,
  });
}

export function useListing(place: UiPlace | null, folderId: string | null) {
  return useQuery({
    queryKey: [...FILES_KEY, "list", place ? placeKey(place) : null, folderId ?? "root"],
    queryFn: () =>
      api<FolderListing>(
        `${placeBase(place as UiPlace)}/list${folderId ? `?folderId=${folderId}` : ""}`,
      ),
    enabled: !!place,
  });
}

/** A client's task files, or Company's (the firm's internal tasks) when `clientId` is null. */
export function useAttachments(clientId: string | null, enabled = true) {
  return useQuery({
    queryKey: [...FILES_KEY, "attachments", clientId ?? "company"],
    queryFn: () =>
      api<AttachmentGroup[]>(
        clientId
          ? `/api/files/clients/${clientId}/attachments`
          : "/api/files/company/attachments",
      ),
    enabled,
  });
}

export function useTrash(enabled = true) {
  return useInfiniteQuery({
    queryKey: [...FILES_KEY, "trash"],
    queryFn: ({ pageParam }) =>
      api<TrashPage>(
        `/api/files/trash${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
    enabled,
  });
}

// ── writes ───────────────────────────────────────────────────────────────────

function useLibraryMutation<TVars, TResult>(run: (vars: TVars) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: run, onSuccess: () => refreshLibrary(queryClient) });
}

export function useCreateFolder() {
  return useLibraryMutation((v: { place: UiPlace; parentId: string | null; name: string }) =>
    api<FolderRow>(`${placeBase(v.place)}/folders`, {
      method: "POST",
      body: { name: v.name, parentId: v.parentId },
    }),
  );
}

/** A text file made in the CRM (files.md §7.4): it lands where the reader is, as an upload does. */
export function useCreateText() {
  return useLibraryMutation(
    (v: { place: UiPlace; folderId: string | null; name: string; text: string }) =>
      api<FileRow>(`${placeBase(v.place)}/text${v.folderId ? `?folderId=${v.folderId}` : ""}`, {
        method: "POST",
        body: { name: v.name, text: v.text },
      }),
  );
}

/** Its text saved again, carrying the version the editor opened, so nobody's work is laid over. */
export function useSaveText() {
  return useLibraryMutation((v: { url: string; text: string; updatedAt: string | null }) =>
    api<FileRow>(v.url, { method: "PATCH", body: { text: v.text, updatedAt: v.updatedAt } }),
  );
}

export function useRename() {
  return useLibraryMutation(
    (v: { place: UiPlace; kind: "file" | "folder"; id: string; name: string }) =>
      api<{ id: string; name: string }>(`${areaBase(v.place)}/${v.kind}s/${v.id}`, {
        method: "PATCH",
        body: { name: v.name },
      }),
  );
}

/** `url` comes from `checkMove`: an admin's move out of a client has a route of its own. */
export function useMove() {
  return useLibraryMutation((v: { url: string; input: MoveInput }) =>
    api<MoveResult>(v.url, { method: "POST", body: v.input }),
  );
}

export function useTrashItems() {
  return useLibraryMutation((v: { place: UiPlace; folderIds: string[]; fileIds: string[] }) =>
    api<TrashResult>(`${areaBase(v.place)}/delete`, {
      method: "POST",
      body: { folderIds: v.folderIds, fileIds: v.fileIds },
    }),
  );
}

export type Restore =
  | { kind: "batch"; batchId: string }
  | { kind: "file" | "folder"; id: string }
  /** a card's Undo, on the card's own gate: it works with Files closed (§9) */
  | { kind: "client-card"; clientId: string; batchId: string }
  | { kind: "task-card"; taskId: string; batchId: string };

function restoreUrl(r: Restore): { url: string; body?: object } {
  switch (r.kind) {
    case "batch":
      return { url: `/api/files/trash/${r.batchId}/restore` };
    case "file":
    case "folder":
      return { url: `/api/files/trash/${r.kind}s/${r.id}/restore` };
    case "client-card":
      return { url: `/api/clients/${r.clientId}/files/undo`, body: { batchId: r.batchId } };
    case "task-card":
      return { url: `/api/tasks/${r.taskId}/files/undo`, body: { batchId: r.batchId } };
  }
}

export function useRestore() {
  return useLibraryMutation((r: Restore) => {
    const { url, body } = restoreUrl(r);
    return api<RestoreResult>(url, { method: "POST", body });
  });
}

/** File to folder (§5.3): into one of the task's client's zones, or into Company. */
export function useFileToFolder() {
  return useLibraryMutation(
    (v: {
      clientId: string | null;
      fileId: string;
      zone?: FileZone;
      folderId: string | null;
    }) =>
      api<{ id: string; name: string }>(
        v.clientId
          ? `/api/files/clients/${v.clientId}/attachments/${v.fileId}/file`
          : `/api/files/company/attachments/${v.fileId}/file`,
        { method: "POST", body: { zone: v.zone, folderId: v.folderId } },
      ),
  );
}

/**
 * A folder upload's call for one directory (§7.2): the folder under `parentId`, found or made. A
 * 429 waits and asks again, as the upload queue does, so a big folder is not cut short.
 */
export async function ensureFolder(
  place: UiPlace,
  parentId: string | null,
  name: string,
): Promise<EnsuredFolder> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await api<EnsuredFolder>(`${placeBase(place)}/folders/ensure`, {
        method: "POST",
        body: { name, parentId },
      });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 429) || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

/**
 * Search (§13): names and details, never inside a file, fifty files a page. The last answer stays
 * on screen while the next is fetched, so the list does not blink at every keystroke.
 */
export function useSearch(query: Omit<SearchQuery, "page">) {
  return useInfiniteQuery({
    queryKey: [...FILES_KEY, "search", query],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ q: query.q, page: String(pageParam) });
      if (query.space) params.set("space", query.space);
      if (query.type) params.set("type", query.type);
      return api<SearchPage>(`/api/files/search?${params.toString()}`);
    },
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.more ? pages.length : undefined),
    placeholderData: keepPreviousData,
    enabled: query.q.length > 0 || !!query.space || !!query.type,
  });
}

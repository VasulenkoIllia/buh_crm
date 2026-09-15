import { Download, Eye, FolderOpen, Paperclip, Search } from "lucide-react";
import type { PlaceInput, SearchHit, SearchQuery } from "@shared/schema/files";
import { cn } from "@/shared/lib/cn";
import { fmtBytes, fmtDate } from "@/shared/lib/format";
import { Button } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";
import { Menu, type MenuItem } from "@/shared/ui/menu";
import { FilterChips, type TabOption } from "@/shared/ui/tabs";
import { ExtBadge, FolderBadge, download } from "./file-bits";
import { useSearch } from "./files.api";
import { useLibrary } from "./library-context";
import {
  CHECK_CELL,
  CrumbTrail,
  EmptyState,
  Loading,
  MENU_CELL,
  Note,
  PaneError,
  PaneFrame,
  ROW,
  TD,
  TH,
} from "./pane-parts";
import type { UiPlace, View } from "./places";

/**
 * **What the search box finds** (files.md §13): names and details — the file, the folder, the
 * uploader, the client and its `#code`, the task — never what is inside a file. Every hit says
 * where it lives, and the menu takes the reader there.
 */

export type SearchFilters = Pick<SearchQuery, "space" | "type">;
type SpaceChoice = NonNullable<SearchQuery["space"]> | "all";
type TypeChoice = NonNullable<SearchQuery["type"]> | "all";

const TYPES: TabOption<TypeChoice>[] = [
  { value: "all", label: "Any type" },
  { value: "pdf", label: "PDF" },
  { value: "image", label: "Pictures" },
  { value: "text", label: "Text" },
  { value: "other", label: "Other" },
];

function uiPlace(place: PlaceInput): UiPlace {
  if (place.space === "personal") return { kind: "my" };
  if (place.space === "company") return { kind: "company" };
  return { kind: "client", clientId: place.clientId, zone: place.zone };
}

/** Where the menu's "Show" goes: the folder a file sits in, the folder itself, or Attachments. */
function viewOfHit(hit: SearchHit): View | null {
  const at = hit.where;
  if (at.kind === "place")
    return { type: "place", place: uiPlace(at.place), folderId: at.folderId };
  if (at.kind === "attachments") return { type: "attachments", clientId: at.clientId };
  return null;
}

/** A file's two routes, on the gate its place is on: the library's, the client card's, a task's. */
function urlsOf(hit: SearchHit): { download: string; view: string } | null {
  const at = hit.where;
  let base: string | null = null;
  if (at.kind === "place") {
    base =
      at.place.space === "client"
        ? `/api/clients/${at.place.clientId}/files/${hit.id}`
        : `/api/files/${at.place.space === "personal" ? "my" : "company"}/files/${hit.id}`;
  } else if (at.kind === "attachments" && at.clientId) {
    base = `/api/clients/${at.clientId}/files/${hit.id}`;
  } else if (hit.task) {
    base = `/api/tasks/${hit.task.id}/files/${hit.id}`;
  }
  return base ? { download: base, view: `${base}/view` } : null;
}

export function SearchPane({
  q,
  filters,
  onFilters,
}: {
  q: string;
  filters: SearchFilters;
  onFilters: (filters: SearchFilters) => void;
}) {
  const lib = useLibrary();
  const search = useSearch({ q, ...filters });
  const hits = search.data?.pages.flatMap((p) => p.hits) ?? [];
  const files = hits.filter((h) => h.kind === "file");
  const spaces: TabOption<SpaceChoice>[] = [
    { value: "all", label: "Everywhere" },
    { value: "my", label: "My files" },
    { value: "company", label: "Company" },
    ...(lib.clientsOpen ? [{ value: "clients" as const, label: "Clients" }] : []),
  ];

  function open(hit: SearchHit) {
    const place = viewOfHit(hit);
    if (hit.kind === "folder") {
      if (place) lib.go(place);
      return;
    }
    const urls = urlsOf(hit);
    if (!urls) return;
    if (!hit.view) {
      download([urls.download]);
      return;
    }
    const list = files.flatMap((f) => {
      const u = urlsOf(f);
      return u
        ? [
            {
              id: f.id,
              name: f.name,
              size: f.size,
              createdAt: f.createdAt,
              uploadedBy: f.uploadedBy,
              view: f.view,
              viewUrl: u.view,
              downloadUrl: u.download,
            },
          ]
        : [];
    });
    lib.openViewer(
      list,
      list.findIndex((f) => f.id === hit.id),
    );
  }

  function actions(hit: SearchHit): (MenuItem | "divider")[] {
    const place = viewOfHit(hit);
    if (hit.kind === "folder") {
      return [{ label: "Open", icon: <FolderOpen size={15} />, onSelect: () => open(hit) }];
    }
    const urls = urlsOf(hit);
    return [
      ...(hit.view && urls
        ? [{ label: "Open", icon: <Eye size={15} />, onSelect: () => open(hit) }]
        : []),
      ...(urls
        ? [
            {
              label: "Download",
              icon: <Download size={15} />,
              onSelect: () => download([urls.download]),
            },
          ]
        : []),
      ...(place
        ? [
            {
              label:
                hit.where.kind === "attachments" ? "Show in Attachments" : "Show in its folder",
              icon: <FolderOpen size={15} />,
              onSelect: () => lib.go(place),
            },
          ]
        : []),
    ];
  }

  let body;
  if (search.error) body = <PaneError error={search.error} />;
  else if (!search.data) body = <Loading />;
  else if (hits.length === 0) {
    body = (
      <EmptyState icon={<Search size={20} />} title={`Nothing matches “${q}”`}>
        Search reads names and details (who uploaded a file, which client, which folder, which
        task), never what is inside a file.
      </EmptyState>
    );
  } else {
    body = (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={cn(TH, CHECK_CELL)} />
              <th className={TH}>Name</th>
              <th className={cn(TH, "text-right")}>Size</th>
              <th className={TH}>Added</th>
              <th className={TH}>Uploaded by</th>
              <th className={cn(TH, MENU_CELL)} />
            </tr>
          </thead>
          <tbody>
            {hits.map((hit) => (
              <tr
                key={`${hit.kind}:${hit.id}`}
                className={cn(ROW, "hover:[&>td]:bg-[#f7f8fa]")}
                onDoubleClick={() => open(hit)}
              >
                <td className={cn(TD, CHECK_CELL)} />
                <td className={cn(TD, "w-[55%] whitespace-normal")}>
                  <div className="flex min-w-0 items-center gap-2.5">
                    {hit.kind === "folder" ? <FolderBadge /> : <ExtBadge name={hit.name} />}
                    <div className="min-w-0">
                      <span className="font-medium text-ink [overflow-wrap:anywhere]">
                        {hit.name}
                      </span>
                      {hit.task && (
                        <Chip
                          tone="blue"
                          size="sm"
                          className="ml-1.5 gap-1 align-[1px]"
                          title="On this task"
                        >
                          <Paperclip size={11} />
                          {hit.task.title}
                        </Chip>
                      )}
                      <span className="block text-[11.5px] text-muted-400">{hit.path}</span>
                    </div>
                  </div>
                </td>
                <td className={cn(TD, "text-right tabular-nums")}>
                  {hit.kind === "folder" ? "—" : fmtBytes(hit.size)}
                </td>
                <td className={TD}>{fmtDate(hit.createdAt)}</td>
                <td className={TD}>{hit.uploadedBy || "—"}</td>
                <td className={cn(TD, MENU_CELL)}>
                  <Menu label={`Actions for ${hit.name}`} items={actions(hit)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {search.hasNextPage && (
          <div className="border-t border-divider px-[18px] py-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={search.isFetchingNextPage}
              onClick={() => void search.fetchNextPage()}
            >
              {search.isFetchingNextPage ? "Loading…" : "Show more"}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <PaneFrame
      label="Search results"
      crumbs={<CrumbTrail parts={[{ key: "search", label: `Files matching “${q}”` }]} />}
      note={
        <Note icon={<Search size={15} />}>
          Names and details only, never what is inside a file. The menu on each row shows where
          it lives.
        </Note>
      }
      bar={
        <div className="flex flex-wrap items-center gap-3">
          <FilterChips<SpaceChoice>
            value={filters.space ?? "all"}
            onChange={(v) => onFilters({ ...filters, space: v === "all" ? undefined : v })}
            options={spaces}
          />
          <FilterChips<TypeChoice>
            value={filters.type ?? "all"}
            onChange={(v) => onFilters({ ...filters, type: v === "all" ? undefined : v })}
            options={TYPES}
          />
        </div>
      }
    >
      {body}
    </PaneFrame>
  );
}

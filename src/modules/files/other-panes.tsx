import type { ReactNode } from "react";
import {
  Download,
  Eye,
  FolderInput,
  Info,
  Paperclip,
  RotateCcw,
  Trash2,
  User,
} from "lucide-react";
import type { AttachmentGroup, FileTotals, TrashBatch } from "@shared/schema/files";
import { FILE_ZONES, ZONE_LABEL, ZONE_NOTE } from "@shared/library";
import { plural } from "@shared/text";
import { cn } from "@/shared/lib/cn";
import { fmtBytes, fmtDate, fmtDateTime } from "@/shared/lib/format";
import { Button } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";
import { ClientCode } from "@/shared/ui/client-code";
import { Menu } from "@/shared/ui/menu";
import { useToast } from "@/shared/ui/toast";
import {
  ExtBadge,
  FolderBadge,
  ZoneDot,
  addTotals,
  download,
  errorText,
  renamedNote,
  sumSizes,
  totalsText,
} from "./file-bits";
import {
  useAttachments,
  useClientDetail,
  useClientNodes,
  useRestore,
  useTrash,
  type Restore,
} from "./files.api";
import { useLibrary } from "./library-context";
import {
  CHECK_CELL,
  CrumbTrail,
  EmptyState,
  GroupHead,
  Loading,
  MENU_CELL,
  Note,
  PaneError,
  PaneFrame,
  ROW,
  TD,
  TH,
  type Crumb,
} from "./pane-parts";
import { COMPANY } from "./places";

/** The panes that are not a folder: the Trash, Attachments, every client, one client. */

// ── the Trash (files.md §9) ──────────────────────────────────────────────────

export function TrashPane() {
  const toast = useToast();
  const trash = useTrash();
  const restore = useRestore();
  const pages = trash.data?.pages ?? [];
  const batches = pages.flatMap((p) => p.batches);
  const totals = pages[0]?.totals;

  async function bringBack(r: Restore, what: string) {
    try {
      const res = await restore.mutateAsync(r);
      toast({
        text: `${what} restored to where ${res.restored === 1 ? "it was" : "they were"}${renamedNote(res.renamed)}`,
      });
    } catch (error) {
      toast({ text: errorText(error, "It could not be restored") });
    }
  }

  let body: ReactNode;
  if (trash.error) body = <PaneError error={trash.error} />;
  else if (!trash.data) body = <Loading />;
  else if (batches.length === 0) {
    body = <EmptyState icon={<Trash2 size={20} />} title="The Trash is empty" />;
  } else {
    body = (
      <>
        {batches.map((b) => (
          <TrashGroup
            key={b.batchId}
            batch={b}
            pending={restore.isPending}
            onRestore={(r, what) => void bringBack(r, what)}
          />
        ))}
        {trash.hasNextPage && (
          <div className="border-t border-divider px-[18px] py-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={trash.isFetchingNextPage}
              onClick={() => void trash.fetchNextPage()}
            >
              {trash.isFetchingNextPage ? "Loading…" : "Show older"}
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <PaneFrame
      label="Trash"
      crumbs={<CrumbTrail parts={[{ key: "trash", label: "Trash" }]} />}
      note={
        <Note icon={<Trash2 size={15} />}>
          Deleted files stay here for 30 days, then they are removed for good. Restoring puts
          them back where they were.
        </Note>
      }
      bar={
        totals && (
          <span className="text-[12.5px] tabular-nums text-muted">
            {`${totalsText(totals)} in the Trash — counted in no folder's total`}
          </span>
        )
      }
    >
      {body}
    </PaneFrame>
  );
}

function TrashGroup({
  batch,
  pending,
  onRestore,
}: {
  batch: TrashBatch;
  pending: boolean;
  onRestore: (r: Restore, what: string) => void;
}) {
  const many = batch.items.length > 1;
  const [first] = batch.items;
  return (
    <div className="border-t border-divider first:border-t-0">
      <GroupHead>
        <span>
          <b className="font-semibold text-ink">{batch.deletedBy}</b> deleted{" "}
          {plural(batch.items.length, "item")} · {fmtDateTime(batch.deletedAt)}
        </span>
        <span className="text-[12px] tabular-nums text-muted">{totalsText(batch.totals)}</span>
        <span className="flex-1" />
        <span
          className={cn(
            "text-[12px] tabular-nums text-muted",
            batch.daysLeft <= 5 && "font-semibold text-danger-text",
          )}
        >
          {plural(batch.daysLeft, "day")} left
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={() =>
            onRestore(
              { kind: "batch", batchId: batch.batchId },
              many || !first ? plural(batch.items.length, "item") : `“${first.name}”`,
            )
          }
        >
          <RotateCcw size={14} />
          {many ? "Restore all" : "Restore"}
        </Button>
      </GroupHead>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <tbody>
            {batch.items.map((item) => (
              <tr key={item.id} className={ROW}>
                <td className={cn(TD, CHECK_CELL)} />
                <td className={cn(TD, "whitespace-normal")}>
                  <div className="flex min-w-0 items-center gap-2.5">
                    {item.kind === "folder" ? <FolderBadge /> : <ExtBadge name={item.name} />}
                    <div className="min-w-0">
                      <span className="font-medium text-ink [overflow-wrap:anywhere]">
                        {item.name}
                      </span>
                      <span className="block text-[11.5px] text-muted-400">
                        from {item.from}
                        {item.kind === "folder" && ` · ${plural(item.totals.files, "file")}`}
                      </span>
                    </div>
                  </div>
                </td>
                <td className={cn(TD, "text-right tabular-nums")}>
                  {fmtBytes(item.totals.bytes)}
                </td>
                <td className={cn(TD, "w-[110px] pr-3 text-right")}>
                  {many && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        onRestore({ kind: item.kind, id: item.id }, `“${item.name}”`)
                      }
                    >
                      Restore
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Attachments: a client's task files, or the firm's internal tasks' (§5, decision 26) ──

export function AttachmentsPane({ clientId }: { clientId: string | null }) {
  const lib = useLibrary();
  const { data, error } = useAttachments(clientId);
  const writable = lib.canWrite(
    clientId ? { kind: "client", clientId, zone: "internal" } : COMPANY,
  );

  const crumbs: Crumb[] = [];
  if (clientId && lib.mode.kind === "firm") {
    const c = lib.client(clientId);
    crumbs.push(
      { key: "clients", label: "Clients", view: { type: "clients" } },
      {
        key: "client",
        label: (
          <>
            {c.label}
            {c.code !== null && <ClientCode code={c.code} className="ml-1.5 min-w-0" />}
          </>
        ),
        view: { type: "client", clientId },
      },
    );
  } else if (!clientId) {
    crumbs.push({
      key: "company",
      label: "Company",
      view: { type: "place", place: COMPANY, folderId: null },
    });
  }
  crumbs.push({ key: "attachments", label: "Attachments" });

  let body: ReactNode;
  if (error) body = <PaneError error={error} />;
  else if (!data) body = <Loading />;
  else if (data.length === 0) {
    body = (
      <EmptyState
        icon={<Paperclip size={20} />}
        title={
          clientId ? "No files on this client's tasks" : "No files on the firm's internal tasks"
        }
      />
    );
  } else {
    body = data.map((g) => (
      <AttachmentGroupView key={g.task.id} group={g} clientId={clientId} writable={writable} />
    ));
  }

  return (
    <PaneFrame
      label="Attachments"
      crumbs={<CrumbTrail parts={crumbs} />}
      note={
        <Note icon={<Paperclip size={15} />}>
          {clientId
            ? "Files on this client's tasks, grouped by task. They are renamed and deleted on their task; here you can download one, or file it into a folder as well."
            : "Files on the firm's internal tasks, grouped by task. They are renamed and deleted on their task; here you can download one, or file it into Company as well."}
        </Note>
      }
      bar={
        data && (
          <span className="text-[12.5px] tabular-nums text-muted">
            {totalsText(sumSizes(data.flatMap((g) => g.files)))} on{" "}
            {plural(data.length, "task")}
          </span>
        )
      }
    >
      {body}
    </PaneFrame>
  );
}

function AttachmentGroupView({
  group,
  clientId,
  writable,
}: {
  group: AttachmentGroup;
  clientId: string | null;
  writable: boolean;
}) {
  const lib = useLibrary();
  // a client's file downloads and opens on the Clients gate; an internal task's on its task's
  const urlOf = (fileId: string) =>
    clientId
      ? `/api/clients/${clientId}/files/${fileId}`
      : `/api/tasks/${group.task.id}/files/${fileId}`;
  // what opens in the CRM opens in the viewer, stepping through this task's files; the rest download
  const open = (index: number) => {
    const file = group.files[index];
    if (!file) return;
    if (!file.view) {
      download([urlOf(file.id)]);
      return;
    }
    lib.openViewer(
      group.files.map((f) => ({
        id: f.id,
        name: f.name,
        size: f.size,
        createdAt: f.createdAt,
        uploadedBy: f.uploadedBy,
        view: f.view,
        viewUrl: `${urlOf(f.id)}/view`,
        downloadUrl: urlOf(f.id),
      })),
      index,
    );
  };
  return (
    <div className="border-t border-divider first:border-t-0">
      <GroupHead>
        <Paperclip size={14} className="text-muted" />
        <b className="font-semibold text-ink">{group.task.title}</b>
        {group.task.archived && (
          <Chip tone="gray" size="sm">
            archived
          </Chip>
        )}
        <span className="flex-1" />
        <span className="text-[12px] tabular-nums text-muted">
          {totalsText(sumSizes(group.files))}
        </span>
      </GroupHead>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <tbody>
            {group.files.map((f, index) => {
              const url = urlOf(f.id);
              return (
                <tr
                  key={f.id}
                  className={cn(ROW, "hover:[&>td]:bg-[#f7f8fa]")}
                  onDoubleClick={() => open(index)}
                >
                  <td className={cn(TD, CHECK_CELL)} />
                  <td className={cn(TD, "w-[55%] whitespace-normal")}>
                    <div className="flex min-w-0 items-center gap-2.5">
                      <ExtBadge name={f.name} />
                      <div className="min-w-0">
                        <span className="font-medium text-ink [overflow-wrap:anywhere]">
                          {f.name}
                        </span>
                        {f.filedIn && (
                          <Chip
                            tone="teal"
                            size="sm"
                            className="ml-1.5 align-[1px]"
                            title="Kept in a folder as well"
                          >
                            Filed in {f.filedIn}
                          </Chip>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className={cn(TD, "text-right tabular-nums")}>{fmtBytes(f.size)}</td>
                  <td className={TD}>{fmtDate(f.createdAt)}</td>
                  <td className={TD}>{f.uploadedBy}</td>
                  <td className={cn(TD, MENU_CELL)}>
                    <Menu
                      label={`Actions for ${f.name}`}
                      items={[
                        ...(f.view
                          ? [
                              {
                                label: "Open",
                                icon: <Eye size={15} />,
                                onSelect: () => open(index),
                              },
                            ]
                          : []),
                        {
                          label: "Download",
                          icon: <Download size={15} />,
                          onSelect: () => download([url]),
                        },
                        ...(writable && !f.filedIn
                          ? [
                              {
                                label: "File to folder…",
                                icon: <FolderInput size={15} />,
                                onSelect: () =>
                                  lib.askFile({ id: f.id, name: f.name }, clientId),
                              },
                            ]
                          : []),
                        "divider",
                        {
                          label: "Rename or delete it on its task",
                          icon: <Info size={15} />,
                          disabled: true,
                          onSelect: () => undefined,
                        },
                      ]}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── every client, and one client ─────────────────────────────────────────────

function FixedTable({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className={cn(TH, CHECK_CELL)} />
            <th className={TH}>Name</th>
            <th className={cn(TH, "text-right")}>Size</th>
            <th className={TH}>Files</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function FixedRow({
  icon,
  name,
  meta,
  totals,
  onOpen,
}: {
  icon: ReactNode;
  name: ReactNode;
  meta?: string;
  totals: FileTotals;
  onOpen: () => void;
}) {
  return (
    <tr className={cn(ROW, "cursor-pointer hover:[&>td]:bg-[#f7f8fa]")} onClick={onOpen}>
      <td className={cn(TD, CHECK_CELL)} />
      <td className={cn(TD, "whitespace-normal")}>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-[30px] w-[30px] flex-none place-items-center rounded-[7px] bg-divider text-ink-700">
            {icon}
          </span>
          <div className="min-w-0">
            <button
              type="button"
              className="inline-flex items-center text-left font-medium text-ink hover:text-primary-link"
              onClick={(e) => {
                e.stopPropagation();
                onOpen();
              }}
            >
              {name}
            </button>
            {meta && <span className="block text-[11.5px] text-muted-400">{meta}</span>}
          </div>
        </div>
      </td>
      <td className={cn(TD, "text-right tabular-nums")}>{fmtBytes(totals.bytes)}</td>
      <td className={TD}>{plural(totals.files, "file")}</td>
    </tr>
  );
}

export function ClientsPane() {
  const lib = useLibrary();
  const { data, error } = useClientNodes(lib.clientsOpen);
  let body: ReactNode;
  if (error) body = <PaneError error={error} />;
  else if (!data) body = <Loading />;
  else if (data.length === 0)
    body = <EmptyState icon={<User size={20} />} title="No clients yet" />;
  else {
    body = (
      <FixedTable>
        {data.map((c) => (
          <FixedRow
            key={c.id}
            icon={<User size={15} />}
            name={
              <>
                {c.label}
                <ClientCode code={c.code} className="ml-2 min-w-0" />
              </>
            }
            totals={c.totals}
            onOpen={() => lib.go({ type: "client", clientId: c.id })}
          />
        ))}
      </FixedTable>
    );
  }
  return (
    <PaneFrame
      label="Clients"
      crumbs={<CrumbTrail parts={[{ key: "clients", label: "Clients" }]} />}
      bar={
        data && (
          <span className="text-[12.5px] tabular-nums text-muted">
            {plural(data.length, "client")} · {totalsText(addTotals(data.map((c) => c.totals)))}
          </span>
        )
      }
    >
      {body}
    </PaneFrame>
  );
}

export function ClientPane({ clientId }: { clientId: string }) {
  const lib = useLibrary();
  const { data, error } = useClientDetail(clientId);
  const label = data?.label ?? lib.client(clientId).label;
  const code = data?.code ?? lib.client(clientId).code;
  let body: ReactNode;
  if (error) body = <PaneError error={error} />;
  else if (!data) body = <Loading />;
  else {
    const filed = data.attachments.filed;
    body = (
      <FixedTable>
        {FILE_ZONES.map((zone) => (
          <FixedRow
            key={zone}
            icon={<ZoneDot zone={zone} />}
            name={ZONE_LABEL[zone]}
            meta={ZONE_NOTE[zone]}
            totals={data.zones[zone]}
            onOpen={() =>
              lib.go({
                type: "place",
                place: { kind: "client", clientId, zone },
                folderId: null,
              })
            }
          />
        ))}
        <FixedRow
          icon={<Paperclip size={15} />}
          name="Attachments"
          meta={`Files on this client's tasks${filed > 0 ? ` · ${filed} also filed in a folder` : ""}`}
          totals={data.attachments}
          onOpen={() => lib.go({ type: "attachments", clientId })}
        />
      </FixedTable>
    );
  }
  return (
    <PaneFrame
      label={"A client's files"}
      crumbs={
        <CrumbTrail
          parts={[
            { key: "clients", label: "Clients", view: { type: "clients" } },
            {
              key: "client",
              label: (
                <>
                  {label}
                  {code !== null && <ClientCode code={code} className="ml-1.5 min-w-0" />}
                </>
              ),
            },
          ]}
        />
      }
      bar={
        data && (
          <span className="text-[12.5px] tabular-nums text-muted">
            {totalsText(data.totals)}
          </span>
        )
      }
    >
      {body}
    </PaneFrame>
  );
}

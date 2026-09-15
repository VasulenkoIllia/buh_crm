import { useMemo, type ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";
import {
  Building2,
  ChevronRight,
  Folder,
  Lock,
  Paperclip,
  Trash2,
  User,
  Users,
} from "lucide-react";
import type { FileTotals, FolderNode } from "@shared/schema/files";
import { FILE_ZONES, ZONE_LABEL } from "@shared/library";
import { cn } from "@/shared/lib/cn";
import { fmtBytes } from "@/shared/lib/format";
import { ClientCode } from "@/shared/ui/client-code";
import { ZoneDot, childrenOf, totalsText } from "./file-bits";
import { useClientDetail, useClientNodes, useFolderTree, useOverview } from "./files.api";
import { clientNodeKey, folderNodeKey, useLibrary, type Target } from "./library-context";
import { COMPANY, MY, placeKey, placeLabel, sameView, type UiPlace, type View } from "./places";

/**
 * **The tree** (files.md §4): the fixed levels first (My files, Company, Clients, Trash), then
 * each place's own folders, a level at a time. Every place and folder in it takes a drop, which is
 * how a row dragged out of the list is moved (§7.3).
 */

const ICON = "flex-none";

function TreeFrame({
  label,
  heading,
  totals,
  children,
}: {
  label: string;
  heading: string;
  totals?: FileTotals;
  children: ReactNode;
}) {
  return (
    <nav
      aria-label={label}
      className="sticky top-4 max-h-[calc(100vh-96px)] overflow-y-auto rounded-(--radius-panel) border border-border bg-surface px-2 pb-3 pt-2.5 shadow-(--shadow-card)"
    >
      <div className="mb-1.5 border-b border-divider px-2.5 pb-2.5 pt-1 text-[12px] text-muted">
        {heading}
        <b className="block text-[13px] font-semibold tabular-nums text-ink">
          {totals ? totalsText(totals) : "…"}
        </b>
      </div>
      {children}
    </nav>
  );
}

interface NodeProps {
  nodeKey: string;
  depth: number;
  icon: ReactNode;
  label: ReactNode;
  title: string;
  totals?: FileTotals | null;
  view: View;
  hasKids: boolean;
  /** a place's root or a folder takes what is dropped on it */
  drop?: Target;
  children?: ReactNode;
}

function Node({
  nodeKey,
  depth,
  icon,
  label,
  title,
  totals,
  view,
  hasKids,
  drop,
  children,
}: NodeProps) {
  const lib = useLibrary();
  const open = hasKids && lib.isOpen(nodeKey);
  const active = sameView(lib.view, view);
  const { setNodeRef, isOver } = useDroppable({
    id: `tree:${nodeKey}`,
    data: drop,
    disabled:
      !drop ||
      !lib.canWrite(drop.place) ||
      (drop.folderId !== null && lib.noDrop.has(drop.folderId)),
  });
  return (
    <>
      <div
        ref={setNodeRef}
        style={{ paddingLeft: depth * 14 }}
        className={cn(
          "flex items-center gap-0.5 rounded-(--radius-btn-sm)",
          active ? "bg-[#eef1fd]" : "hover:bg-[#f7f8fa]",
          isOver && "bg-[#eef1fd] shadow-[inset_0_0_0_2px_var(--color-primary)]",
        )}
      >
        <button
          type="button"
          tabIndex={hasKids ? 0 : -1}
          aria-hidden={hasKids ? undefined : true}
          aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
          aria-expanded={hasKids ? open : undefined}
          onClick={() => lib.toggle(nodeKey)}
          className={cn(
            "grid h-[26px] w-5 flex-none place-items-center rounded text-faint hover:text-ink-700",
            !hasKids && "invisible",
          )}
        >
          <ChevronRight
            size={13}
            className={cn(
              "transition-transform motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
        </button>
        <button
          type="button"
          title={title}
          aria-current={active ? "page" : undefined}
          onClick={() => lib.go(view)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 p-1 text-left text-[13px]",
            active ? "font-semibold text-primary-link" : "text-ink-700",
          )}
        >
          {icon}
          {label}
        </button>
        {totals && (
          <span className="whitespace-nowrap pr-2 text-[11.5px] tabular-nums text-muted-400">
            {fmtBytes(totals.bytes)}
          </span>
        )}
      </div>
      {open && children}
    </>
  );
}

function FolderBranch({
  folder,
  place,
  kids,
  depth,
}: {
  folder: FolderNode;
  place: UiPlace;
  kids: Map<string | null, FolderNode[]>;
  depth: number;
}) {
  const below = kids.get(folder.id) ?? [];
  return (
    <Node
      nodeKey={folderNodeKey(folder.id)}
      depth={depth}
      icon={<Folder size={15} className={cn(ICON, "text-[#b07800]")} />}
      label={<span className="truncate">{folder.name}</span>}
      title={folder.name}
      totals={folder.totals}
      view={{ type: "place", place, folderId: folder.id }}
      hasKids={below.length > 0}
      drop={{ place, folderId: folder.id, label: folder.name }}
    >
      {below.map((f) => (
        <FolderBranch key={f.id} folder={f} place={place} kids={kids} depth={depth + 1} />
      ))}
    </Node>
  );
}

function PlaceNode({
  place,
  depth,
  icon,
  label,
  longLabel,
  totals,
  after,
}: {
  place: UiPlace;
  depth: number;
  icon: ReactNode;
  label: string;
  /** "Petrenko › Internal" where the tree only says "Internal" */
  longLabel?: string;
  totals?: FileTotals | null;
  /** a fixed node under the folders: Company's Attachments */
  after?: ReactNode;
}) {
  const { data } = useFolderTree(place);
  const kids = useMemo(() => childrenOf(data ?? []), [data]);
  const roots = kids.get(null) ?? [];
  return (
    <Node
      nodeKey={placeKey(place)}
      depth={depth}
      icon={icon}
      label={<span className="truncate">{label}</span>}
      title={longLabel ?? label}
      totals={totals}
      view={{ type: "place", place, folderId: null }}
      hasKids={roots.length > 0 || after !== undefined}
      drop={{ place, folderId: null, label: longLabel ?? label }}
    >
      {roots.map((f) => (
        <FolderBranch key={f.id} folder={f} place={place} kids={kids} depth={depth + 1} />
      ))}
      {after}
    </Node>
  );
}

/** A client's three zones and its Attachments. */
function ZoneNodes({ clientId, depth }: { clientId: string; depth: number }) {
  const lib = useLibrary();
  const { data } = useClientDetail(clientId);
  const name = lib.client(clientId).label;
  return (
    <>
      {FILE_ZONES.map((zone) => {
        const place: UiPlace = { kind: "client", clientId, zone };
        return (
          <PlaceNode
            key={zone}
            place={place}
            depth={depth}
            icon={<ZoneDot zone={zone} />}
            label={ZONE_LABEL[zone]}
            longLabel={placeLabel(place, name)}
            totals={data?.zones[zone]}
          />
        );
      })}
      <Node
        nodeKey={`att:${clientId}`}
        depth={depth}
        icon={<Paperclip size={15} className={ICON} />}
        label={<span className="truncate">Attachments</span>}
        title={"Files on this client's tasks"}
        totals={data?.attachments}
        view={{ type: "attachments", clientId }}
        hasKids={false}
      />
    </>
  );
}

function ClientsBranch({ totals }: { totals: FileTotals }) {
  const lib = useLibrary();
  const { data: clients } = useClientNodes(lib.isOpen("clients"));
  return (
    <Node
      nodeKey="clients"
      depth={0}
      icon={<Users size={15} className={ICON} />}
      label={<span className="truncate">Clients</span>}
      title="Clients"
      totals={totals}
      view={{ type: "clients" }}
      hasKids
    >
      {(clients ?? []).map((c) => (
        <Node
          key={c.id}
          nodeKey={clientNodeKey(c.id)}
          depth={1}
          icon={<User size={15} className={ICON} />}
          label={
            <>
              <span className="truncate">{c.label}</span>
              <ClientCode code={c.code} className="min-w-0 text-[11px]" />
            </>
          }
          title={c.label}
          totals={c.totals}
          view={{ type: "client", clientId: c.id }}
          hasKids
        >
          <ZoneNodes clientId={c.id} depth={2} />
        </Node>
      ))}
    </Node>
  );
}

/** The Files screen's tree: everything the reader may open. */
export function FirmTree() {
  const { data: overview } = useOverview();
  const attachments = overview?.companyAttachments ? (
    <Node
      nodeKey="att:company"
      depth={1}
      icon={<Paperclip size={15} className={ICON} />}
      label={<span className="truncate">Attachments</span>}
      title={"Files on the firm's internal tasks"}
      totals={overview.companyAttachments}
      view={{ type: "attachments", clientId: null }}
      hasKids={false}
    />
  ) : undefined;
  return (
    <TreeFrame label="Folders" heading="All files" totals={overview?.all}>
      <PlaceNode
        place={MY}
        depth={0}
        icon={<Lock size={15} className={ICON} />}
        label="My files"
        totals={overview?.mine}
      />
      <PlaceNode
        place={COMPANY}
        depth={0}
        icon={<Building2 size={15} className={ICON} />}
        label="Company"
        totals={overview?.company}
        after={attachments}
      />
      {overview?.clients && <ClientsBranch totals={overview.clients} />}
      <div className="h-1.5" />
      <Node
        nodeKey="trash"
        depth={0}
        icon={<Trash2 size={15} className={ICON} />}
        label={<span className="truncate">Trash</span>}
        title="Trash"
        totals={overview?.trash}
        view={{ type: "trash" }}
        hasKids={false}
      />
    </TreeFrame>
  );
}

/** A client card's tree: that client's zones and Attachments, nothing else. */
export function ClientTree({ clientId }: { clientId: string }) {
  const { data } = useClientDetail(clientId);
  return (
    <TreeFrame
      label="This client's folders"
      heading={"This client's files"}
      totals={data?.totals}
    >
      <ZoneNodes clientId={clientId} depth={0} />
    </TreeFrame>
  );
}

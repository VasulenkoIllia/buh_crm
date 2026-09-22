import { useMemo, useState, type ReactNode } from "react";
import { Folder, FolderOpen, Info } from "lucide-react";
import { clientCode } from "@shared/schema/client";
import { FILE_ZONES, ZONE_LABEL, type FileZone } from "@shared/library";
import { plural } from "@shared/text";
import { useCanEdit } from "@/app/auth";
import { useKeepChatFile } from "@/modules/chat";
import { cn } from "@/shared/lib/cn";
import { fmtBytes } from "@/shared/lib/format";
import { Button } from "@/shared/ui/button";
import { Input, Label, Textarea } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { SearchSelect } from "@/shared/ui/search-select";
import { Segmented } from "@/shared/ui/segmented";
import { useToast } from "@/shared/ui/toast";
import { childrenOf, errorText } from "./file-bits";
import { useClientNodes, useFileToFolder, useFolderTree } from "./files.api";
import { pickedFacts, useLibrary, type Picked, type Target } from "./library-context";
import { checkMove } from "./move-rules";
import {
  COMPANY,
  MY,
  clientSees,
  placeInput,
  placeLabel,
  samePlace,
  type UiPlace,
} from "./places";

/** The library's dialogs: where to move, where to file, and whether to delete or upload. */

type Space = UiPlace["kind"];
const SPACES: { value: Space; label: string }[] = [
  { value: "my", label: "My files" },
  { value: "company", label: "Company" },
  { value: "client", label: "A client" },
];
const ZONES: { value: FileZone; label: string }[] = FILE_ZONES.map((z) => ({
  value: z,
  label: ZONE_LABEL[z],
}));

function Line({ tone, children }: { tone: "info" | "warn"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-(--radius-card) px-3 py-2 text-[12.5px]",
        tone === "warn" ? "bg-[#fff4dc] text-[#8a5a00]" : "bg-[#eef1fd] text-[#243a9e]",
      )}
    >
      <Info size={15} className="mt-px flex-none" />
      <span>{children}</span>
    </div>
  );
}

/**
 * One place's folders to choose from, its root first. The folders being moved are shown and
 * refused, and nothing under them is offered: a folder cannot go inside itself.
 */
export function FolderPicker({
  place,
  rootLabel,
  value,
  onChange,
  blocked,
  current,
}: {
  place: UiPlace;
  rootLabel: string;
  /** undefined while nothing is chosen; null is the root */
  value: string | null | undefined;
  onChange: (folderId: string | null) => void;
  blocked?: ReadonlySet<string>;
  /** where the items are now, in this place; undefined when they are elsewhere */
  current?: string | null;
}) {
  const { data, isLoading } = useFolderTree(place);
  const rows = useMemo(() => {
    const kids = childrenOf(data ?? []);
    const out: { id: string | null; name: string; depth: number; why?: string }[] = [
      { id: null, name: rootLabel, depth: 0, why: current === null ? "here now" : undefined },
    ];
    const walk = (parent: string | null, depth: number) => {
      for (const f of kids.get(parent) ?? []) {
        const moving = blocked?.has(f.id) ?? false;
        out.push({
          id: f.id,
          name: f.name,
          depth,
          why: moving ? "being moved" : current === f.id ? "here now" : undefined,
        });
        if (!moving) walk(f.id, depth + 1);
      }
    };
    walk(null, 1);
    return out;
  }, [data, rootLabel, blocked, current]);

  return (
    <div
      role="listbox"
      aria-label="Folders"
      className="max-h-[260px] overflow-y-auto rounded-(--radius-card) border border-border p-1"
    >
      {isLoading ? (
        <p className="p-2 text-[13px] text-muted">Loading…</p>
      ) : (
        rows.map((r) => (
          <button
            key={r.id ?? "root"}
            type="button"
            role="option"
            aria-selected={value === r.id}
            disabled={r.why !== undefined}
            onClick={() => onChange(r.id)}
            style={{ paddingLeft: 8 + r.depth * 16 }}
            className={cn(
              "flex w-full items-center gap-2 rounded-(--radius-btn-sm) py-1.5 pr-2 text-left text-[13px] text-ink-700",
              "hover:bg-[#f7f8fa] disabled:cursor-not-allowed disabled:text-faint disabled:hover:bg-transparent",
              value === r.id &&
                "bg-[#eef1fd] font-semibold text-primary-link hover:bg-[#eef1fd]",
            )}
          >
            {r.id === null ? (
              <FolderOpen size={15} className="flex-none" />
            ) : (
              <Folder size={15} className="flex-none text-[#b07800]" />
            )}
            <span className="truncate">{r.name}</span>
            {r.why && (
              <span className="ml-auto whitespace-nowrap text-[11px] font-normal text-faint">
                {r.why}
              </span>
            )}
          </button>
        ))
      )}
    </div>
  );
}

// ── Move (files.md §6.2) ─────────────────────────────────────────────────────

export function MoveDialog({
  picked,
  initial,
  onClose,
}: {
  picked: Picked;
  /** a drag's drop, when there was something to say before moving */
  initial?: Target;
  onClose: () => void;
}) {
  const lib = useLibrary();
  const from = picked.place;
  // a client card moves within its client, and so does anyone who is not an admin (§11.1)
  const locked = lib.mode.kind === "client" || (from.kind === "client" && !lib.admin);
  const start = initial?.place ?? from;
  const [space, setSpace] = useState<Space>(start.kind);
  const [clientId, setClientId] = useState(start.kind === "client" ? start.clientId : "");
  const [zone, setZone] = useState<FileZone>(start.kind === "client" ? start.zone : "internal");
  const [folderId, setFolderId] = useState<string | null | undefined>(initial?.folderId);
  const clients = useClientNodes(!locked && lib.clientsOpen);

  const to: UiPlace | null =
    space === "my"
      ? MY
      : space === "company"
        ? COMPANY
        : clientId
          ? { kind: "client", clientId, zone }
          : null;
  const { data: tree } = useFolderTree(to);
  const facts = pickedFacts(picked);
  const moving = useMemo(() => new Set(picked.folders.map((f) => f.id)), [picked]);
  const nameOf = (id: string) => lib.client(id).label;

  const target: Target | null =
    to && folderId !== undefined
      ? {
          place: to,
          folderId,
          label: folderId
            ? (tree?.find((f) => f.id === folderId)?.name ?? "the folder")
            : placeLabel(to, to.kind === "client" ? nameOf(to.clientId) : undefined),
        }
      : null;
  const check = target
    ? checkMove({
        from,
        to: target.place,
        files: facts.files,
        onTasks: facts.onTasks,
        admin: lib.admin,
        clientName: nameOf,
      })
    : null;
  const unchanged =
    !!target && samePlace(target.place, from) && target.folderId === picked.parentId;
  const first = picked.folders[0] ?? picked.files[0];
  const what = facts.items === 1 && first ? `“${first.name}”` : plural(facts.items, "item");
  const reset = () => setFolderId(undefined);

  async function submit() {
    if (!target || !check?.allowed) return;
    if (await lib.runMove(picked, target, check.url)) onClose();
  }

  return (
    <Modal
      open
      size="md"
      title={`Move ${what}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!target || !check?.allowed || unchanged || lib.movePending}
            onClick={() => void submit()}
          >
            {target ? `Move to ${target.label}` : "Move"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px] text-ink-700">
        {locked ? (
          <span>
            {lib.mode.kind === "client"
              ? "From a client card, files move within this client. Moving them anywhere else is on the Files screen."
              : "Files move within this client. Only an admin moves them anywhere else."}
          </span>
        ) : (
          <Segmented<Space>
            value={space}
            onChange={(v) => {
              setSpace(v);
              reset();
            }}
            options={SPACES.filter((s) => s.value !== "client" || lib.clientsOpen)}
          />
        )}
        {space === "client" && !locked && (
          <SearchSelect
            value={clientId}
            options={(clients.data ?? []).map((c) => ({
              value: c.id,
              label: c.label,
              hint: clientCode(c.code),
            }))}
            placeholder="Find a client…"
            ariaLabel="Client"
            onChange={(v) => {
              setClientId(v);
              reset();
            }}
          />
        )}
        {space === "client" && clientId && (
          <Segmented<FileZone>
            value={zone}
            onChange={(z) => {
              setZone(z);
              reset();
            }}
            options={ZONES}
          />
        )}
        {to && (
          <FolderPicker
            place={to}
            rootLabel={to.kind === "client" ? ZONE_LABEL[to.zone] : placeLabel(to)}
            value={folderId}
            onChange={setFolderId}
            blocked={moving}
            current={samePlace(to, from) ? picked.parentId : undefined}
          />
        )}
        {check && !check.allowed && <Line tone="warn">{check.reason}</Line>}
        {check?.lines.map((l) => (
          <Line key={l.text} tone={l.tone}>
            {l.text}
          </Line>
        ))}
      </div>
    </Modal>
  );
}

// ── Keeping a chat's file (chat.md §6.5) ─────────────────────────────────────

/**
 * **A file sent in a chat, kept as the firm's** (owner, 2026-09-22). A chat is a conversation, and
 * what it carries goes with the message; a document the firm means to hold on to belongs in the
 * library, which has the Trash, the thirty days, the search and the folders.
 *
 * It is a COPY, and the dialog says so: the chat keeps its own. The place picker is the move
 * dialog's, because there is no reason for a second one — My files, Company, or a client's zone,
 * and then a folder inside it.
 */
export function KeepChatFileDialog({
  file,
  onClose,
}: {
  file: { fileId: string; name: string };
  onClose: () => void;
}) {
  const toast = useToast();
  const keep = useKeepChatFile();
  const clientsOpen = useCanEdit("clients");
  const [space, setSpace] = useState<Space>("my");
  const [clientId, setClientId] = useState("");
  const [zone, setZone] = useState<FileZone>("internal");
  const [folderId, setFolderId] = useState<string | null | undefined>(null);
  const [error, setError] = useState<string | null>(null);
  const clients = useClientNodes(clientsOpen);

  const to: UiPlace | null =
    space === "my"
      ? MY
      : space === "company"
        ? COMPANY
        : clientId
          ? { kind: "client", clientId, zone }
          : null;
  const { data: tree } = useFolderTree(to);
  const reset = () => setFolderId(null);
  const label = folderId
    ? (tree?.find((f) => f.id === folderId)?.name ?? "the folder")
    : to
      ? placeLabel(
          to,
          to.kind === "client"
            ? clients.data?.find((c) => c.id === clientId)?.label
            : undefined,
        )
      : "";

  async function submit() {
    if (!to || folderId === undefined) return;
    setError(null);
    try {
      const kept = await keep.mutateAsync({
        fileId: file.fileId,
        to: placeInput(to),
        folderId: folderId ?? undefined,
      });
      toast({
        text:
          kept.name === file.name
            ? `Kept in ${label} — the chat still has its own`
            : `Kept in ${label} as “${kept.name}”, the name was taken`,
      });
      onClose();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <Modal
      open
      size="md"
      title={`Keep “${file.name}” in Files`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!to || keep.isPending} onClick={() => void submit()}>
            {to ? `Keep in ${label}` : "Keep"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px] text-ink-700">
        <span>
          A copy goes into the library, where it has the Trash and its thirty days. The chat
          keeps its own, and deleting the message will not touch this one.
        </span>
        <Segmented<Space>
          value={space}
          onChange={(v) => {
            setSpace(v);
            setFolderId(null);
          }}
          options={SPACES.filter((s) => s.value !== "client" || clientsOpen)}
        />
        {space === "client" && (
          <SearchSelect
            value={clientId}
            options={(clients.data ?? []).map((c) => ({
              value: c.id,
              label: c.label,
              hint: clientCode(c.code),
            }))}
            placeholder="Find a client…"
            ariaLabel="Client"
            onChange={(v) => {
              setClientId(v);
              reset();
            }}
          />
        )}
        {space === "client" && clientId && (
          <Segmented<FileZone>
            value={zone}
            onChange={(z) => {
              setZone(z);
              reset();
            }}
            options={ZONES}
          />
        )}
        {to && (
          <FolderPicker
            place={to}
            rootLabel={to.kind === "client" ? ZONE_LABEL[to.zone] : placeLabel(to)}
            value={folderId}
            onChange={setFolderId}
          />
        )}
        {error && <Line tone="warn">{error}</Line>}
      </div>
    </Modal>
  );
}

// ── File to folder (§5.3) ────────────────────────────────────────────────────

/**
 * **A task's file, filed in a folder as well**: one of the task's client's zones, or Company for
 * an internal task. It stays on its task, one file in two places. Used by Attachments and by the
 * task card, so it stands on its own and needs no library around it.
 */
export function FileToFolderDialog({
  file,
  clientId,
  clientName,
  onClose,
}: {
  file: { id: string; name: string };
  clientId: string | null;
  clientName?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const fileIt = useFileToFolder();
  const [zone, setZone] = useState<FileZone>("internal");
  const [folderId, setFolderId] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const place: UiPlace = clientId ? { kind: "client", clientId, zone } : COMPANY;
  const { data: tree } = useFolderTree(place);
  const label = folderId
    ? (tree?.find((f) => f.id === folderId)?.name ?? "the folder")
    : clientId
      ? ZONE_LABEL[zone]
      : "Company";
  const who = clientName ?? "The client";

  async function submit() {
    if (folderId === undefined) return;
    setError(null);
    try {
      const filed = await fileIt.mutateAsync({
        clientId,
        fileId: file.id,
        zone: clientId ? zone : undefined,
        folderId,
      });
      toast({
        text:
          filed.name === file.name
            ? `Filed in ${label} — and still on its task`
            : `Filed in ${label} as “${filed.name}”, the name was taken — and still on its task`,
      });
      onClose();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <Modal
      open
      size="md"
      title={`File “${file.name}” into a folder`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={folderId === undefined || fileIt.isPending}
            onClick={() => void submit()}
          >
            File here
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px] text-ink-700">
        <span>
          It stays on its task as well — one file, shown in both places.{" "}
          {clientId
            ? `Only ${clientName ?? "this client"}'s folders are offered.`
            : "An internal task's file is filed in Company."}
        </span>
        {clientId && (
          <Segmented<FileZone>
            value={zone}
            onChange={(z) => {
              setZone(z);
              setFolderId(undefined);
            }}
            options={ZONES}
          />
        )}
        <FolderPicker
          place={place}
          rootLabel={clientId ? ZONE_LABEL[zone] : "Company"}
          value={folderId}
          onChange={setFolderId}
        />
        {clientSees(place) && <Line tone="info">{who} will see it once the portal opens.</Line>}
        {error && <Line tone="warn">{error}</Line>}
      </div>
    </Modal>
  );
}

// ── Delete (§9) ──────────────────────────────────────────────────────────────

export function DeleteDialog({
  picked,
  pending,
  onConfirm,
  onClose,
}: {
  picked: Picked;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const f = pickedFacts(picked);
  const [folder] = picked.folders;
  const oneFolder = folder && picked.folders.length === 1 && picked.files.length === 0;
  const onTasks = picked.files.filter((x) => x.task);
  const [onTask] = onTasks;
  return (
    <Modal
      open
      title={
        oneFolder
          ? `Move the folder “${folder.name}” to the Trash?`
          : `Move ${plural(f.items, "item")} to the Trash?`
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={pending} onClick={onConfirm} autoFocus>
            {pending ? "Moving…" : "Move to Trash"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5 text-[13px] text-ink-700">
        <div className="flex gap-6 rounded-(--radius-card) bg-divider px-3 py-2.5 tabular-nums">
          <div className="flex flex-col">
            <b className="text-[16px] text-ink">{f.files}</b>
            <span className="text-[11.5px] text-muted">
              {f.files === 1 ? "file" : "files"}
              {f.inFolders > 0 && ", counting inside folders"}
            </span>
          </div>
          <div className="flex flex-col">
            <b className="text-[16px] text-ink">{fmtBytes(f.bytes)}</b>
            <span className="text-[11.5px] text-muted">in all</span>
          </div>
        </div>
        <span>Everything stays in the Trash for 30 days, and comes back in one click.</span>
        {onTask && (
          <Line tone="warn">
            {onTasks.length === 1
              ? `“${onTask.name}” is also on a task — it leaves the task too, and comes back with it.`
              : `${onTasks.length} of them are also on tasks — they leave their tasks too, and come back with them.`}
          </Line>
        )}
      </div>
    </Modal>
  );
}

// ── Upload into what the client sees (§4.2) ──────────────────────────────────

export function UploadConfirmDialog({
  count,
  target,
  clientName,
  onConfirm,
  onClose,
}: {
  count: number;
  target: Target;
  clientName: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open
      title={`Upload into ${target.label}?`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onConfirm} autoFocus>
            Upload {plural(count, "file")}
          </Button>
        </>
      }
    >
      <Line tone="info">
        {clientName} will see {count === 1 ? "this file" : `these ${count} files`} once the
        portal opens. Putting a file here is showing it to the client.
      </Line>
    </Modal>
  );
}

/**
 * **A text file made here** (files.md §7.4): a name and the text, into the folder that is open.
 * `.txt` is added when the name has none, and a taken name gets "(2)", exactly as an upload does.
 * Renaming it later is the row's own menu, as for every other file.
 */
export function NewTextFileDialog({
  target,
  busy,
  error,
  onCreate,
  onClose,
}: {
  target: Target;
  busy: boolean;
  error: string | null;
  onCreate: (name: string, text: string) => void;
  onClose: () => void;
}) {
  // the person names it; the CRM puts the extension on, so what is made is always a text file
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  return (
    <Modal
      open
      size="lg"
      title={`New text file in ${target.label}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => onCreate(name, text)} disabled={busy || name.trim() === ""}>
            {busy ? "Saving…" : "Create"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-text-name">File name</Label>
          <div className="flex items-center gap-2">
            <Input
              id="new-text-name"
              value={name}
              autoFocus
              className="flex-1"
              onChange={(e) => setName(e.target.value)}
              placeholder="Notes"
            />
            <span className="text-[13px] tabular-nums text-muted">.txt</span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-text-body">Text</Label>
          <Textarea
            id="new-text-body"
            value={text}
            rows={14}
            className="font-mono text-[12.5px]"
            onChange={(e) => setText(e.target.value)}
            placeholder="Type the text here."
          />
        </div>
        {clientSees(target.place) && (
          <Line tone="info">The client will see it once the portal opens.</Line>
        )}
        {error && <Line tone="warn">{error}</Line>}
      </div>
    </Modal>
  );
}

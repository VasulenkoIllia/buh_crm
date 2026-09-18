import { Suspense, useEffect, useRef, useState } from "react";
import { Download, Eye, Paperclip, X } from "lucide-react";
import { MAX_UPLOAD_BYTES, isRefusedFile } from "@shared/library";
import { SECRET_FILES_MAX, type SecretFileRow } from "@shared/schema/secrets";
import { FileViewer, type Viewable } from "@/modules/files";
import { ApiError } from "@/shared/lib/api";
import { fmtBytes } from "@/shared/lib/format";
import { Button, IconButton } from "@/shared/ui/button";
import {
  attachSecretFile,
  removeSecretFile,
  secretFileUrl,
  secretFileViewUrl,
} from "./secrets.api";
import { UnlockModal, useVaultWindow } from "./unlock";

/**
 * **A free-form secret's files** (secrets.md §21): up to five, of the kinds the CRM accepts, opened
 * or downloaded only behind the vault's five minutes, as a value is shown.
 */

/** What the form will do to the files when it is saved: nothing happens before Save. */
export interface FileChanges {
  adds: File[];
  removes: Set<string>;
}
export const NO_FILE_CHANGES: FileChanges = { adds: [], removes: new Set() };

export const hasFileChanges = (c: FileChanges) => c.adds.length > 0 || c.removes.size > 0;

const heading = "text-[11px] font-semibold uppercase tracking-[.04em] text-muted-400";
const row = "flex items-center gap-2 border-b border-divider py-1.5 text-[13px] last:border-0";

/** The form's part: the files kept, the ones added, and Attach while there is room. */
export function AttachmentsField({
  files,
  changes,
  onChange,
}: {
  files: SecretFileRow[];
  changes: FileChanges;
  onChange: (next: FileChanges) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const kept = files.filter((f) => !changes.removes.has(f.id));
  const count = kept.length + changes.adds.length;

  // the server holds every rule; these are the ones worth saying before anything is sent
  const pick = (list: FileList | null) => {
    const room = SECRET_FILES_MAX - count;
    const taken: File[] = [];
    const left: string[] = [];
    for (const file of Array.from(list ?? [])) {
      if (isRefusedFile(file.name)) left.push(`“${file.name}” is a program or a script`);
      else if (file.size > MAX_UPLOAD_BYTES) left.push(`“${file.name}” is over 25 MB`);
      else if (taken.length >= room)
        left.push(`“${file.name}”: ${SECRET_FILES_MAX} files at most`);
      else taken.push(file);
    }
    setRefused(left.length ? left.join(". ") : null);
    if (taken.length) onChange({ ...changes, adds: [...changes.adds, ...taken] });
  };

  return (
    <div className="space-y-2 border-t border-divider pt-3">
      <p className={heading}>Files</p>
      {count > 0 && (
        <div>
          {kept.map((file) => (
            <div key={file.id} className={row}>
              <Paperclip size={14} className="flex-none text-muted" />
              <span className="min-w-0 flex-1 truncate text-ink">{file.name}</span>
              <span className="text-[12px] tabular-nums text-muted">{fmtBytes(file.size)}</span>
              <IconButton
                label={`Remove ${file.name}`}
                className="hover:text-danger"
                onClick={() =>
                  onChange({ ...changes, removes: new Set(changes.removes).add(file.id) })
                }
              >
                <X size={14} />
              </IconButton>
            </div>
          ))}
          {changes.adds.map((file, i) => (
            <div key={`${file.name}-${i}`} className={row}>
              <Paperclip size={14} className="flex-none text-primary-link" />
              <span className="min-w-0 flex-1 truncate text-ink">{file.name}</span>
              <span className="text-[12px] tabular-nums text-muted">{fmtBytes(file.size)}</span>
              <IconButton
                label={`Do not attach ${file.name}`}
                className="hover:text-danger"
                onClick={() =>
                  onChange({ ...changes, adds: changes.adds.filter((_, j) => j !== i) })
                }
              >
                <X size={14} />
              </IconButton>
            </div>
          ))}
        </div>
      )}
      <Button
        variant="secondary"
        size="sm"
        disabled={count >= SECRET_FILES_MAX}
        onClick={() => input.current?.click()}
      >
        <Paperclip size={14} />
        Attach files
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label="Files to attach"
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = "";
        }}
      />
      {refused && <p className="text-[12px] text-danger-text">{refused}</p>}
    </div>
  );
}

/**
 * What Save does after the secret itself is saved: the removals, then the additions, one at a
 * time. Answers what did not go through, in words; an empty list is all of it.
 */
export async function applyFileChanges(secretId: string, changes: FileChanges) {
  const failed: string[] = [];
  const why = (e: unknown) => (e instanceof ApiError ? e.message : "it did not go through");
  for (const fileId of changes.removes) {
    await removeSecretFile(fileId).catch((e) => failed.push(why(e)));
  }
  for (const file of changes.adds) {
    await attachSecretFile(secretId, file).catch((e) => failed.push(`${file.name}: ${why(e)}`));
  }
  return failed;
}

/** A download without leaving the page: the route answers `attachment`. */
function downloadFile(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** The entry window's part: each file, opened in the CRM when it can be, or downloaded. */
export function AttachmentsList({ files }: { files: SecretFileRow[] }) {
  const { unlocked } = useVaultWindow();
  const [viewing, setViewing] = useState<number | null>(null);
  // what was asked for while the vault was locked, done the moment the password is accepted
  const [waiting, setWaiting] = useState<(() => void) | null>(null);

  // the files close with the vault's five minutes, as the values do
  useEffect(() => {
    if (!unlocked) setViewing(null);
  }, [unlocked]);

  const behindUnlock = (act: () => void) => (unlocked ? act() : setWaiting(() => act));
  const items: Viewable[] = files.map((f) => ({
    id: f.id,
    name: f.name,
    size: f.size,
    createdAt: f.createdAt,
    view: f.view,
    viewUrl: secretFileViewUrl(f.id),
    downloadUrl: secretFileUrl(f.id),
  }));

  return (
    <div>
      <p className={`mb-1 ${heading}`}>Files</p>
      {files.map((file, i) => (
        <div key={file.id} className={row}>
          <Paperclip size={14} className="flex-none text-muted" />
          <span className="min-w-0 flex-1 truncate text-ink">{file.name}</span>
          <span className="text-[12px] tabular-nums text-muted">{fmtBytes(file.size)}</span>
          {file.view && (
            <IconButton
              label={`Open ${file.name}`}
              onClick={() => behindUnlock(() => setViewing(i))}
            >
              <Eye size={14} />
            </IconButton>
          )}
          <IconButton
            label={`Download ${file.name}`}
            onClick={() => behindUnlock(() => downloadFile(secretFileUrl(file.id)))}
          >
            <Download size={14} />
          </IconButton>
        </div>
      ))}
      {viewing !== null && (
        <Suspense
          // the frame stands while the viewer loads, rather than the window behind it showing through
          fallback={
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
              <div className="flex h-[92vh] w-full max-w-[1100px] items-center justify-center rounded-(--radius-panel) bg-surface text-[13px] text-muted shadow-(--shadow-modal)">
                Opening…
              </div>
            </div>
          }
        >
          <FileViewer
            items={items}
            index={viewing}
            onIndex={setViewing}
            onClose={() => setViewing(null)}
          />
        </Suspense>
      )}
      {waiting && (
        <UnlockModal
          onDone={() => {
            const act = waiting;
            setWaiting(null);
            act();
          }}
          onClose={() => setWaiting(null)}
        />
      )}
    </div>
  );
}

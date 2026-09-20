import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileText, RotateCcw, X } from "lucide-react";
import { CHAT_FILES_MAX, type ChatFile } from "@shared/schema/chat";
import { MAX_UPLOAD_BYTES, isRefusedFile } from "@shared/library";
import { cn } from "@/shared/lib/cn";
import { fmtBytes } from "@/shared/lib/format";
import { drawPreview } from "./photo-preview";

/**
 * **Files on their way into a chat, and files a message carries** (chat.md §6).
 *
 * Sending is two steps on purpose (§6.1): each file goes up by itself, with its own progress and
 * its own retry, and the message is sent once they are all there. So a 20 MB scan that fails on the
 * third attempt costs the words nothing, and a message never arrives naming a file that is not
 * stored.
 *
 * XMLHttpRequest rather than `fetch`, for the same reason the library's queue uses it: only it
 * reports upload progress.
 */

const AT_ONCE = 3;
const MAX_ATTEMPTS = 5;

export interface Pending {
  id: number;
  file: File;
  /** the small JPEG this browser drew, if it could (§6.2) */
  preview: Blob | null;
  /** that preview as something an `<img>` can show, while it is still going up */
  localUrl: string | null;
  progress: number;
  state: "drawing" | "waiting" | "sending" | "done" | "failed";
  error?: string;
  attempts: number;
  notBefore: number;
  sent?: { fileId: string; previewFileId: string | null };
}

function messageOf(xhr: XMLHttpRequest): string {
  try {
    return (
      (JSON.parse(xhr.responseText) as { error?: { message?: string } }).error?.message ?? ""
    );
  } catch {
    return "";
  }
}

export function useAttachments(chatId: string) {
  const [items, setItems] = useState<Pending[]>([]);
  const live = useRef<Pending[]>([]);
  const seq = useRef(0);
  const wake = useRef<number | undefined>(undefined);

  const commit = (next: Pending[]) => {
    live.current = next;
    setItems(next);
  };
  const patch = (id: number, change: Partial<Pending>) =>
    commit(live.current.map((i) => (i.id === id ? { ...i, ...change } : i)));

  const pump = useCallback(() => {
    const now = Date.now();
    let sending = live.current.filter((i) => i.state === "sending").length;
    for (const item of live.current.filter(
      (i) => i.state === "waiting" && i.notBefore <= now,
    )) {
      if (sending >= AT_ONCE) break;
      sending++;
      send(item.id);
    }
    const later = live.current.filter((i) => i.state === "waiting" && i.notBefore > now);
    if (later.length > 0) {
      window.clearTimeout(wake.current);
      wake.current = window.setTimeout(
        pump,
        Math.min(...later.map((i) => i.notBefore)) - now + 20,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the queue through its ref
  }, [chatId]);

  function send(id: number) {
    const item = live.current.find((i) => i.id === id);
    if (!item) return;
    patch(id, { state: "sending", attempts: item.attempts + 1, progress: 0 });
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/chat/chats/${chatId}/files`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) patch(id, { progress: e.loaded / e.total });
    };
    xhr.onload = () => {
      const current = live.current.find((i) => i.id === id);
      if (xhr.status === 201) {
        const body = JSON.parse(xhr.responseText) as {
          fileId: string;
          previewFileId: string | null;
        };
        patch(id, { state: "done", progress: 1, sent: body });
      } else if (xhr.status === 429 && (current?.attempts ?? 0) < MAX_ATTEMPTS) {
        const seconds = Number(xhr.getResponseHeader("Retry-After"));
        const wait = (Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000;
        patch(id, { state: "waiting", progress: 0, notBefore: Date.now() + wait });
      } else {
        patch(id, { state: "failed", error: messageOf(xhr) || `Refused (${xhr.status})` });
      }
      pump();
    };
    xhr.onerror = () => {
      patch(id, { state: "failed", error: "The connection dropped" });
      pump();
    };
    const form = new FormData();
    form.append("file", item.file);
    if (item.preview) form.append("preview", item.preview, "preview.jpg");
    xhr.send(form);
  }

  /** Picked, dropped or pasted. What cannot be sent is handed back, by name, for one line to say. */
  const add = useCallback(
    (files: File[]) => {
      const refused: string[] = [];
      const tooBig: string[] = [];
      const room = CHAT_FILES_MAX - live.current.length;
      const taking = files.slice(0, Math.max(0, room));
      const tooMany = files.length > taking.length;
      const next = [...live.current];
      for (const file of taking) {
        if (isRefusedFile(file.name)) refused.push(file.name);
        else if (file.size > MAX_UPLOAD_BYTES) tooBig.push(file.name);
        else {
          const id = ++seq.current;
          next.push({
            id,
            file,
            preview: null,
            localUrl: null,
            progress: 0,
            // the picture is drawn first, so it goes up in the same request as the photo
            state: "drawing",
            attempts: 0,
            notBefore: 0,
          });
          void drawPreview(file).then((preview) => {
            const still = live.current.find((i) => i.id === id);
            if (!still) return;
            patch(id, {
              preview,
              localUrl: preview ? URL.createObjectURL(preview) : null,
              state: "waiting",
            });
            pump();
          });
        }
      }
      commit(next);
      return { refused, tooBig, tooMany };
    },
    [pump],
  );

  const forget = (item: Pending) => {
    if (item.localUrl) URL.revokeObjectURL(item.localUrl);
  };

  const drop = useCallback((id: number) => {
    const item = live.current.find((i) => i.id === id);
    if (item) forget(item);
    commit(live.current.filter((i) => i.id !== id));
  }, []);

  const retry = useCallback(
    (id: number) => {
      patch(id, { state: "waiting", attempts: 0, notBefore: 0, error: undefined });
      pump();
    },
    [pump],
  );

  const clear = useCallback(() => {
    for (const item of live.current) forget(item);
    commit([]);
  }, []);

  // the object URLs are this tab's memory, and a chat left open all day would keep every one
  useEffect(() => clear, [clear]);
  useEffect(() => {
    clear();
  }, [chatId, clear]);

  return {
    items,
    add,
    drop,
    retry,
    clear,
    /** everything is stored, so the message may go */
    ready: items.length > 0 && items.every((i) => i.state === "done"),
    busy: items.some(
      (i) => i.state === "drawing" || i.state === "waiting" || i.state === "sending",
    ),
    failed: items.filter((i) => i.state === "failed").length,
    forSend: () => items.flatMap((i) => (i.sent ? [i.sent] : [])),
  };
}

export type Attachments = ReturnType<typeof useAttachments>;

/** What is about to be sent, above the composer: each file's own progress and its own retry. */
export function AttachmentStrip({ queue }: { queue: Attachments }) {
  if (queue.items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 border-b border-divider px-3 py-2">
      {queue.items.map((item) => (
        <div
          key={item.id}
          className={cn(
            "relative flex w-[168px] items-center gap-2 overflow-hidden rounded-(--radius-field)",
            "border border-border bg-surface px-2 py-1.5",
            item.state === "failed" && "border-danger-text",
          )}
        >
          {item.localUrl ? (
            <img src={item.localUrl} alt="" className="size-8 shrink-0 rounded object-cover" />
          ) : (
            <FileText className="size-4 shrink-0 text-muted" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px]">{item.file.name}</p>
            <p className="text-[11px] text-muted">
              {item.state === "failed"
                ? item.error
                : item.state === "done"
                  ? fmtBytes(item.file.size)
                  : `${Math.round(item.progress * 100)}%`}
            </p>
          </div>
          {item.state === "failed" && (
            <button
              type="button"
              aria-label="Try again"
              onClick={() => queue.retry(item.id)}
              className="text-muted hover:text-ink"
            >
              <RotateCcw className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            aria-label={`Remove ${item.file.name}`}
            onClick={() => queue.drop(item.id)}
            className="text-muted hover:text-ink"
          >
            <X className="size-3.5" />
          </button>
          {item.state !== "done" && item.state !== "failed" && (
            <span
              className="absolute bottom-0 left-0 h-0.5 bg-primary transition-[width]"
              style={{ width: `${Math.round(item.progress * 100)}%` }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ── what a message carries (§6.2) ──────────────────────────────────────────────

export const chatFileUrl = (fileId: string, door: "view" | "download" | "preview") =>
  `/api/chat/files/${fileId}/${door}`;

/**
 * The files under a message: photos as pictures, everything else as a card with its name and size.
 * A photo with no preview — one this sender's browser could not draw — is a card too, which is
 * what §6.2 says a HEIC outside Safari becomes.
 */
export function MessageFiles({ files, mine }: { files: ChatFile[]; mine: boolean }) {
  if (files.length === 0) return null;
  const photos = files.filter((f) => f.previewFileId !== null);
  const rest = files.filter((f) => f.previewFileId === null);
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {photos.length > 0 && (
        <div className={cn("grid gap-1", photos.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
          {photos.map((file) => (
            <a
              key={file.fileId}
              href={chatFileUrl(file.fileId, "view")}
              target="_blank"
              rel="noreferrer"
              title={`${file.name} · ${fmtBytes(file.size)}`}
            >
              <img
                src={chatFileUrl(file.previewFileId!, "preview")}
                alt={file.name}
                loading="lazy"
                className="max-h-[220px] w-full rounded-(--radius-field) object-cover"
              />
            </a>
          ))}
        </div>
      )}
      {rest.map((file) => (
        <a
          key={file.fileId}
          href={chatFileUrl(file.fileId, file.view ? "view" : "download")}
          target="_blank"
          rel="noreferrer"
          className={cn(
            "flex items-center gap-2 rounded-(--radius-field) border px-2 py-1.5 text-[12.5px]",
            mine ? "border-white/40 hover:bg-white/10" : "border-border hover:bg-divider",
          )}
        >
          <FileText className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{file.name}</span>
          <span className={cn("text-[11px]", mine ? "text-white/80" : "text-muted")}>
            {fmtBytes(file.size)}
          </span>
          <Download className="size-3.5 shrink-0" />
        </a>
      ))}
    </div>
  );
}

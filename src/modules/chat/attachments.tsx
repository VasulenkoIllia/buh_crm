import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileText, RotateCcw, X } from "lucide-react";
import { CHAT_FILES_MAX, type ChatFile } from "@shared/schema/chat";
import type { Viewable } from "@/modules/files";
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
  /**
   * The requests in the air, by item. Kept in a ref rather than on the item: an XHR is not state,
   * and what it is for is being able to stop it — removing a file that is going up used to leave it
   * uploading to the end and land in the bucket as an orphan (review, 2026-09-20).
   */
  const flying = useRef(new Map<number, XMLHttpRequest>());
  const stop = (id: number) => {
    flying.current.get(id)?.abort();
    flying.current.delete(id);
  };

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
    flying.current.set(id, xhr);
    xhr.open("POST", `/api/chat/chats/${chatId}/files`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) patch(id, { progress: e.loaded / e.total });
    };
    xhr.onload = () => {
      flying.current.delete(id);
      const current = live.current.find((i) => i.id === id);
      if (xhr.status === 201) {
        // a 201 with a body that is not what it should be would otherwise throw here, and the item
        // would stand at "sending" for ever, with no error and no retry (review, 2026-09-20)
        try {
          const body = JSON.parse(xhr.responseText) as {
            fileId: string;
            previewFileId: string | null;
          };
          if (typeof body.fileId !== "string") throw new Error("no file id");
          patch(id, { state: "done", progress: 1, sent: body });
        } catch {
          patch(id, { state: "failed", error: "The server's answer made no sense" });
        }
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
      flying.current.delete(id);
      patch(id, { state: "failed", error: "The connection dropped" });
      pump();
    };
    // aborted by `drop` or `clear`: the item is gone, and nothing is left to say about it
    xhr.onabort = () => flying.current.delete(id);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- patch reads the queue through its ref
    [pump],
  );

  const forget = (item: Pending) => {
    if (item.localUrl) URL.revokeObjectURL(item.localUrl);
  };

  const drop = useCallback((id: number) => {
    const item = live.current.find((i) => i.id === id);
    if (item) forget(item);
    stop(id);
    commit(live.current.filter((i) => i.id !== id));
  }, []);

  const retry = useCallback(
    (id: number) => {
      patch(id, { state: "waiting", attempts: 0, notBefore: 0, error: undefined });
      pump();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- patch reads the queue through its ref
    [pump],
  );

  const clear = useCallback(() => {
    for (const item of live.current) {
      forget(item);
      stop(item.id);
    }
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
 * A chat file as the CRM's own viewer takes it (files.md §12): the same window that opens a
 * document in Files, over the chat's own two doors. Only what the CRM can show is passed to it;
 * everything else downloads.
 */
export const viewableOf = (file: ChatFile, at: string): Viewable => ({
  id: file.fileId,
  name: file.name,
  size: file.size,
  createdAt: at,
  view: file.view,
  viewUrl: chatFileUrl(file.fileId, "view"),
  downloadUrl: chatFileUrl(file.fileId, "download"),
});

/** A file card, in a bubble that is the reader's own or somebody else's. */
const card = (mine: boolean) =>
  cn(
    "flex w-full items-center gap-2 rounded-(--radius-field) border px-2 py-1.5 text-[12.5px]",
    mine ? "border-white/40 hover:bg-white/10" : "border-border hover:bg-divider",
  );

/**
 * The files under a message: photos as pictures, everything else as a card with its name and size.
 * A photo with no preview — one this sender's browser could not draw — is a card too, which is
 * what §6.2 says a HEIC outside Safari becomes.
 */
export function MessageFiles({
  files,
  mine,
  onOpen,
}: {
  files: ChatFile[];
  mine: boolean;
  /** opens the CRM's viewer on this message's files; what it cannot show is a download */
  onOpen: (files: ChatFile[], index: number) => void;
}) {
  if (files.length === 0) return null;
  const photos = files.filter((f) => f.previewFileId !== null);
  const rest = files.filter((f) => f.previewFileId === null);
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {photos.length > 0 && (
        <div className={cn("grid gap-1", photos.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
          {photos.map((file) => (
            <button
              key={file.fileId}
              type="button"
              onClick={() => onOpen(files, files.indexOf(file))}
              title={`${file.name} · ${fmtBytes(file.size)}`}
              className={photos.length > 1 ? "min-w-0" : "flex min-w-0 justify-start"}
            >
              <img
                src={chatFileUrl(file.previewFileId!, "preview")}
                alt={file.name}
                loading="lazy"
                decoding="async"
                // one photo keeps its own shape and is never stretched past the preview's own size
                // (owner, 2026-09-20: a stretched 320 px preview was the blur); several share a
                // grid, where a square cell reads better than four different shapes
                className={cn(
                  "rounded-(--radius-field)",
                  photos.length > 1
                    ? "aspect-square w-full object-cover"
                    : "max-h-[320px] w-auto max-w-full object-contain",
                )}
              />
            </button>
          ))}
        </div>
      )}
      {rest.map((file) =>
        file.view ? (
          <button
            key={file.fileId}
            type="button"
            onClick={() => onOpen(files, files.indexOf(file))}
            className={card(mine)}
          >
            <FileText className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">{file.name}</span>
            <span className={cn("text-[11px]", mine ? "text-white/80" : "text-muted")}>
              {fmtBytes(file.size)}
            </span>
          </button>
        ) : (
          <a
            key={file.fileId}
            href={chatFileUrl(file.fileId, "download")}
            target="_blank"
            rel="noreferrer"
            className={card(mine)}
          >
            <FileText className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{file.name}</span>
            <span className={cn("text-[11px]", mine ? "text-white/80" : "text-muted")}>
              {fmtBytes(file.size)}
            </span>
            <Download className="size-3.5 shrink-0" />
          </a>
        ),
      )}
    </div>
  );
}

import { useCallback, useRef, useState } from "react";
import { X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { MAX_UPLOAD_BYTES, isRefusedFile } from "@shared/library";
import { fmtBytes } from "@/shared/lib/format";
import { cn } from "@/shared/lib/cn";
import { IconButton } from "@/shared/ui/button";
import { refreshLibrary } from "./files.api";
import { placeBase, type UiPlace } from "./places";

/**
 * **The upload queue** (files.md §7.1): as many files as are dropped, three on the wire at a time,
 * one file per request, each with its own progress. On a 429 it waits the `Retry-After` the server
 * sent and carries on; a name taken at the same moment (409) is simply sent again, and the server
 * hands out the next `(n)`. It survives moving between folders: files land where they were dropped.
 *
 * XMLHttpRequest rather than `fetch`, because only it reports upload progress.
 */

export interface UploadTarget {
  place: UiPlace;
  folderId: string | null;
  /** where, in words, for the panel */
  label: string;
}

interface Item {
  id: number;
  file: File;
  target: UploadTarget;
  progress: number;
  state: "waiting" | "sending" | "done" | "failed";
  error?: string;
  attempts: number;
  /** not before this moment: a 429's Retry-After */
  notBefore: number;
}

const AT_ONCE = 3;
const MAX_ATTEMPTS = 5;

function messageOf(xhr: XMLHttpRequest): string {
  try {
    return (
      (JSON.parse(xhr.responseText) as { error?: { message?: string } }).error?.message ?? ""
    );
  } catch {
    return "";
  }
}

export function useUploadQueue() {
  const queryClient = useQueryClient();
  const [items, setItems] = useState<Item[]>([]);
  const live = useRef<Item[]>([]);
  const seq = useRef(0);
  const wake = useRef<number | undefined>(undefined);

  const commit = (next: Item[]) => {
    live.current = next;
    setItems(next);
  };
  const patch = (id: number, change: Partial<Item>) =>
    commit(live.current.map((i) => (i.id === id ? { ...i, ...change } : i)));

  const pump = useCallback(() => {
    const now = Date.now();
    let sending = live.current.filter((i) => i.state === "sending").length;
    const ready = live.current.filter((i) => i.state === "waiting" && i.notBefore <= now);
    for (const item of ready) {
      if (sending >= AT_ONCE) break;
      sending++;
      send(item.id);
    }
    const later = live.current.filter((i) => i.state === "waiting" && i.notBefore > now);
    if (later.length > 0) {
      window.clearTimeout(wake.current);
      const soonest = Math.min(...later.map((i) => i.notBefore));
      wake.current = window.setTimeout(pump, soonest - now + 20);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the queue through its ref
  }, []);

  function send(id: number) {
    const item = live.current.find((i) => i.id === id);
    if (!item) return;
    patch(id, { state: "sending", attempts: item.attempts + 1, progress: 0 });
    const xhr = new XMLHttpRequest();
    const folder = item.target.folderId ? `?folderId=${item.target.folderId}` : "";
    xhr.open("POST", `${placeBase(item.target.place)}/upload${folder}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) patch(id, { progress: e.loaded / e.total });
    };
    xhr.onload = () => {
      const current = live.current.find((i) => i.id === id);
      if (xhr.status === 201) {
        patch(id, { state: "done", progress: 1 });
        void refreshLibrary(queryClient);
      } else if (
        (xhr.status === 429 || xhr.status === 409) &&
        (current?.attempts ?? 0) < MAX_ATTEMPTS
      ) {
        // Retry-After in seconds, as this server sends it; anything else (a date from a proxy)
        // waits five, rather than a NaN that would leave the file waiting for ever
        const seconds = Number(xhr.getResponseHeader("Retry-After"));
        const wait =
          xhr.status === 429
            ? (Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000
            : 100;
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
    xhr.send(form);
  }

  /** Queue the files for one place; what is refused before sending is handed back, by name. */
  const enqueue = useCallback(
    (files: File[], target: UploadTarget) => {
      const refused: string[] = [];
      const tooBig: string[] = [];
      const next = [...live.current];
      for (const file of files) {
        if (isRefusedFile(file.name)) refused.push(file.name);
        else if (file.size > MAX_UPLOAD_BYTES) tooBig.push(file.name);
        else {
          next.push({
            id: ++seq.current,
            file,
            target,
            progress: 0,
            state: "waiting",
            attempts: 0,
            notBefore: 0,
          });
        }
      }
      commit(next);
      pump();
      return { refused, tooBig };
    },
    [pump],
  );

  const cancelRest = () => commit(live.current.filter((i) => i.state !== "waiting"));
  const clear = () =>
    commit(live.current.filter((i) => i.state === "waiting" || i.state === "sending"));

  return { items, enqueue, cancelRest, clear };
}

export type UploadQueue = ReturnType<typeof useUploadQueue>;

export function UploadQueuePanel({ queue }: { queue: UploadQueue }) {
  const { items } = queue;
  if (items.length === 0) return null;
  const done = items.filter((i) => i.state === "done").length;
  const failed = items.filter((i) => i.state === "failed").length;
  const busy = items.some((i) => i.state === "waiting" || i.state === "sending");
  const last = items[items.length - 1];
  return (
    <div
      role="status"
      className="fixed bottom-6 right-6 z-[55] w-[350px] overflow-hidden rounded-(--radius-panel) border border-border bg-surface shadow-(--shadow-modal)"
    >
      <div className="flex items-center gap-2 border-b border-divider bg-[#fafbfc] py-2.5 pl-3.5 pr-2.5 text-[13px]">
        <div className="min-w-0 flex-1">
          <div className="font-semibold">
            {busy
              ? `Uploading ${Math.min(done + 1, items.length)} of ${items.length}`
              : `${done} of ${items.length} uploaded${failed ? ` · ${failed} refused` : ""}`}
          </div>
          <div className="truncate text-[11.5px] text-muted">
            {busy ? "Three at a time" : `into ${last.target.label}`}
          </div>
        </div>
        {busy ? (
          <button
            type="button"
            className="rounded-(--radius-btn-sm) px-2 py-1 text-[12.5px] text-ink-700 hover:bg-divider"
            onClick={queue.cancelRest}
          >
            Cancel the rest
          </button>
        ) : (
          <IconButton label="Close" onClick={queue.clear}>
            <X size={15} />
          </IconButton>
        )}
      </div>
      <ul className="max-h-[240px] overflow-y-auto">
        {items.map((i) => (
          <li
            key={i.id}
            className="border-b border-divider px-3.5 py-2 text-[12.5px] last:border-b-0"
          >
            <div className="flex justify-between gap-2">
              <span className="truncate">{i.file.name}</span>
              <span
                className={cn(
                  "flex-none tabular-nums text-muted",
                  i.state === "failed" && "text-danger-text",
                )}
              >
                {i.state === "done"
                  ? "Done"
                  : i.state === "waiting"
                    ? "Waiting"
                    : i.state === "failed"
                      ? "Refused"
                      : `${Math.round(i.progress * 100)}%`}{" "}
                · {fmtBytes(i.file.size)}
              </span>
            </div>
            {i.state === "failed" && i.error && (
              <div className="mt-0.5 text-[11.5px] text-danger-text">{i.error}</div>
            )}
            <div className="mt-1.5 h-1 overflow-hidden rounded-sm bg-divider">
              <div
                className={cn(
                  "h-full rounded-sm",
                  i.state === "done" ? "bg-success" : "bg-primary",
                )}
                style={{ width: `${Math.round(i.progress * 100)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

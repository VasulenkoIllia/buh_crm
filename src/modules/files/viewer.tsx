import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Download, ExternalLink, Pencil, X } from "lucide-react";
import type { FileView } from "@shared/schema/files";
import { extensionOf } from "@shared/library";
import { api } from "@/shared/lib/api";
import { fmtBytes, fmtDate } from "@/shared/lib/format";
import { Button, IconButton } from "@/shared/ui/button";
import { Modal } from "@/shared/ui/modal";
import { parseCsv } from "./csv";
import { ExtBadge, download, errorText } from "./file-bits";

/** A file the viewer can step through: what it shows, and where its two routes are. */
export interface Viewable {
  id: string;
  name: string;
  size: number;
  createdAt: string;
  /** who uploaded it, where the list says (the task card's does not) */
  uploadedBy?: string;
  view: FileView;
  viewUrl: string;
  downloadUrl: string;
  /** when its bytes last changed; the editor sends it back, so no save lands on another (§7.4) */
  updatedAt?: string | null;
  /** where its text is saved again, when the reader may write where it sits */
  saveUrl?: string;
}

const TEXT_CAP = 512 * 1024;
const CSV_ROWS = 1000;

/**
 * **The viewer** (files.md §12): a window in the middle of the screen that steps through the
 * files of what is open. A PDF opens in the browser's own viewer, in a plain frame: never
 * sandboxed, never pdf.js. A picture opens as a picture. Text and CSV are fetched and drawn by the
 * CRM, escaped. Everything else shows its type and a Download. Download, and Open in new tab for a
 * PDF, are always there. The owner chose the middle over a panel at the side (2026-09-15).
 *
 * Every open is a logged read, so nothing is fetched ahead of the file on screen.
 */
export function Viewer({
  items,
  index,
  onIndex,
  onClose,
  onSave,
}: {
  items: Viewable[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  /** saves the text of a file that says where it is saved; without it nothing here is editable */
  onSave?: (file: Viewable, text: string) => Promise<void>;
}) {
  const file = items[index];
  // a full click on the dim around the window closes it, as a Modal does: down AND up there, so a
  // text selection that ends outside the window does not
  const downOnBackdrop = useRef(false);
  // the text as it was opened, and the draft being typed: null means nobody is editing (§7.4)
  const [loaded, setLoaded] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<{ run: () => void } | null>(null);
  const fileId = file?.id;
  const dirty = draft !== null && draft !== loaded;
  const editable =
    Boolean(onSave) &&
    Boolean(file?.saveUrl) &&
    (file?.view === "text" || file?.view === "csv");

  // stepping to another file starts again: its text, and nothing half typed from the one before
  useEffect(() => {
    setLoaded(null);
    setDraft(null);
    setSaveError(null);
  }, [fileId]);

  /** Leaving the text behind is asked about once, and only while something is unsaved. */
  const leave = (run: () => void) => {
    if (dirty) setLeaving({ run });
    else {
      setDraft(null);
      run();
    }
  };

  async function save() {
    if (draft === null || !onSave || !file) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(file, draft);
      setLoaded(draft);
      setDraft(null);
    } catch (error) {
      setSaveError(errorText(error));
    } finally {
      setSaving(false);
    }
  }

  // no dependency list: the handler is rebound each render, so it never reads a stale draft
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // the question about unsaved text owns the keyboard while it stands
      if (leaving) {
        if (e.key === "Escape") {
          e.stopPropagation();
          setLeaving(null);
        }
        return;
      }
      // Cmd+S, or Ctrl+S, saves what is being typed, as every editor does
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && draft !== null) {
        e.preventDefault();
        e.stopPropagation();
        void save();
        return;
      }
      if (e.key === "Escape") {
        // Escape belongs to the innermost open thing, as in info-hint.tsx: this listens on
        // `document` and a modal on `window`, so opened from the task card the viewer closes and
        // the card stays
        e.stopPropagation();
        leave(onClose);
        return;
      }
      // the arrows step through the files, but never out of a box somebody is typing in
      if (typing(e.target) || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key === "ArrowLeft" && index > 0) leave(() => onIndex(index - 1));
      else if (e.key === "ArrowRight" && index < items.length - 1)
        leave(() => onIndex(index + 1));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  if (!file) return null;
  return (
    // stopPropagation as in Modal: nothing pressed in here reaches whatever rendered the viewer
    // (a task card's modal, the library's drag and drop)
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => {
        e.stopPropagation();
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (downOnBackdrop.current && e.target === e.currentTarget) leave(onClose);
        downOnBackdrop.current = false;
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Viewing ${file.name}`}
        className="flex h-[92vh] w-full max-w-[1100px] flex-col overflow-hidden rounded-(--radius-panel) bg-surface shadow-(--shadow-modal)"
      >
        <div className="flex items-center gap-2 border-b border-border px-3.5 py-3">
          <IconButton
            label="Previous file"
            disabled={index === 0}
            onClick={() => leave(() => onIndex(index - 1))}
          >
            <ChevronLeft size={16} />
          </IconButton>
          <IconButton
            label="Next file"
            disabled={index === items.length - 1}
            onClick={() => leave(() => onIndex(index + 1))}
          >
            <ChevronRight size={16} />
          </IconButton>
          <div className="min-w-0 flex-1">
            <b className="block truncate text-[14px] font-semibold text-ink">{file.name}</b>
            <span className="text-[12px] tabular-nums text-muted">
              {index + 1} of {items.length} · {fmtBytes(file.size)} ·{" "}
              {file.uploadedBy ? `${file.uploadedBy}, ` : ""}
              {fmtDate(file.createdAt)}
            </span>
          </div>
          <IconButton label="Close the viewer" onClick={() => leave(onClose)}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[#e9ecf0] p-6">
          <Body
            key={file.id}
            file={file}
            draft={draft}
            onDraft={setDraft}
            onLoaded={setLoaded}
          />
        </div>
        <div className="flex items-center gap-2 border-t border-border px-3.5 py-3">
          <span className="flex-1 text-[12px] text-muted">
            {saveError ? (
              <span className="text-danger-text">{saveError}</span>
            ) : draft !== null ? (
              "Cmd+S saves. The file keeps its name; rename it from its row."
            ) : (
              "Every open and every download is kept in the activity log."
            )}
          </span>
          {editable && draft === null && (
            <Button
              variant="secondary"
              size="sm"
              disabled={loaded === null}
              title={loaded === null ? "Editing opens once the text is on screen" : undefined}
              onClick={() => setDraft(loaded ?? "")}
            >
              <Pencil size={14} />
              Edit
            </Button>
          )}
          {draft !== null && (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={saving}
                onClick={() => leave(() => setDraft(null))}
              >
                Cancel
              </Button>
              <Button size="sm" disabled={saving || !dirty} onClick={() => void save()}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </>
          )}
          <Button variant="secondary" size="sm" onClick={() => download([file.downloadUrl])}>
            <Download size={14} />
            Download
          </Button>
          {file.view === "pdf" && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.open(file.viewUrl, "_blank", "noopener")}
            >
              <ExternalLink size={14} />
              Open in new tab
            </Button>
          )}
        </div>
      </div>
      {leaving && (
        <Modal
          open
          size="sm"
          title="Leave without saving?"
          onClose={() => setLeaving(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setLeaving(null)}>
                Keep editing
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  const run = leaving.run;
                  setLeaving(null);
                  setDraft(null);
                  run();
                }}
              >
                Discard
              </Button>
            </>
          }
        >
          <p className="text-[13px] text-ink-700">
            The changes to “{file.name}” have not been saved.
          </p>
        </Modal>
      )}
    </div>
  );
}

function typing(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

function Body({
  file,
  draft,
  onDraft,
  onLoaded,
}: {
  file: Viewable;
  draft: string | null;
  onDraft: (text: string) => void;
  onLoaded: (text: string) => void;
}) {
  switch (file.view) {
    case "pdf":
      return <PdfFrame file={file} />;
    case "image":
      return <Picture file={file} />;
    case "text":
    case "csv":
      return <TextView file={file} draft={draft} onDraft={onDraft} onLoaded={onLoaded} />;
    default:
      return <NotShown file={file} />;
  }
}

function Note({ children }: { children: ReactNode }) {
  return <p className="max-w-[320px] text-center text-[13px] text-muted">{children}</p>;
}

/**
 * The session is checked through a JSON route before a frame's source is set, never by probing the
 * view itself: that would be a logged read, and an expired session would put raw JSON in the frame.
 */
function useSignedIn() {
  const [state, setState] = useState<"checking" | "yes" | "no">("checking");
  useEffect(() => {
    let live = true;
    api("/api/auth/me")
      .then(() => live && setState("yes"))
      .catch(() => live && setState("no"));
    return () => {
      live = false;
    };
  }, []);
  return state;
}

function PdfFrame({ file }: { file: Viewable }) {
  const signedIn = useSignedIn();
  if (signedIn === "checking") return <Note>Opening…</Note>;
  if (signedIn === "no")
    return <Note>Your session has ended. Sign in again to open this file.</Note>;
  // a plain frame, never `sandbox`: every browser refuses a PDF in a sandboxed one (§12.1)
  return (
    <iframe
      src={file.viewUrl}
      title={file.name}
      className="h-full w-full rounded-[3px] bg-white shadow-[0_2px_10px_rgba(0,0,0,0.1)]"
    />
  );
}

function Picture({ file }: { file: Viewable }) {
  const [broken, setBroken] = useState(false);
  // HEIC shows in Safari alone; elsewhere, and with a session gone, the picture fails to a download
  if (broken) {
    return (
      <NotShown
        file={file}
        reason="This picture does not show in this browser. Download it to open it."
      />
    );
  }
  return (
    <img
      src={file.viewUrl}
      alt={file.name}
      onError={() => setBroken(true)}
      className="max-h-full max-w-full rounded-[3px] object-contain shadow-[0_2px_10px_rgba(0,0,0,0.1)]"
    />
  );
}

/**
 * One request per open, even when React's development mode runs an effect twice: the second run
 * picks up the first one's request instead of sending, and logging, another. Once it settles the
 * entry goes, so opening the file again later is a new read.
 */
const inFlight = new Map<string, Promise<string>>();
function fetchText(url: string): Promise<string> {
  const pending = inFlight.get(url);
  if (pending) return pending;
  const request = fetch(url, { credentials: "same-origin" }).then(async (res) => {
    if (!res.ok) throw new Error(String(res.status));
    return res.text();
  });
  inFlight.set(url, request);
  request
    .finally(() => window.setTimeout(() => inFlight.delete(url), 0))
    .catch(() => undefined);
  return request;
}

function TextView({
  file,
  draft,
  onDraft,
  onLoaded,
}: {
  file: Viewable;
  draft?: string | null;
  onDraft?: (text: string) => void;
  onLoaded?: (text: string) => void;
}) {
  const [state, setState] = useState<{ text: string; cut: boolean } | "loading" | "failed">(
    "loading",
  );
  useEffect(() => {
    let live = true;
    fetchText(file.viewUrl)
      .then((text) => {
        if (!live) return;
        const cut = text.length > TEXT_CAP;
        setState({ text: text.slice(0, TEXT_CAP), cut });
        // only a file that is here whole may be edited: saving what was cut would lose the rest
        if (!cut) onLoaded?.(text);
      })
      .catch(() => live && setState("failed"));
    return () => {
      live = false;
    };
  }, [file.viewUrl, onLoaded]);

  if (draft !== null && draft !== undefined) {
    return (
      <div className="flex h-full w-full self-stretch">
        <textarea
          value={draft}
          autoFocus
          spellCheck={false}
          aria-label={`The text of ${file.name}`}
          onChange={(e) => onDraft?.(e.target.value)}
          className="h-full w-full resize-none rounded-[3px] border border-border bg-white px-5 py-4 font-mono text-[12.5px] leading-relaxed text-ink shadow-[0_2px_10px_rgba(0,0,0,0.1)] outline-none focus:border-primary"
        />
      </div>
    );
  }
  if (state === "loading") return <Note>Opening…</Note>;
  if (state === "failed")
    return <Note>This file could not be opened. Download it instead.</Note>;
  return (
    <div className="w-full self-start">
      {file.view === "csv" ? (
        <CsvTable text={state.text} />
      ) : (
        <pre className="m-0 rounded-[3px] bg-white px-5 py-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink shadow-[0_2px_10px_rgba(0,0,0,0.1)] [overflow-wrap:anywhere]">
          {state.text}
        </pre>
      )}
      {state.cut && (
        <p className="mt-2 text-[12px] text-muted">
          Showing the first 512 KB. Download the file for the rest.
        </p>
      )}
    </div>
  );
}

function CsvTable({ text }: { text: string }) {
  const rows = parseCsv(text, CSV_ROWS + 1);
  const [head, ...body] = rows;
  if (!head) return <Note>This file is empty.</Note>;
  return (
    <div className="overflow-auto rounded-[3px] bg-white shadow-[0_2px_10px_rgba(0,0,0,0.1)]">
      <table className="border-collapse text-[12px]">
        <thead>
          <tr>
            {head.map((cell, i) => (
              <th
                key={i}
                className="sticky top-0 border-b border-border bg-[#fafbfc] px-2.5 py-1.5 text-left font-semibold whitespace-nowrap text-ink-700"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.slice(0, CSV_ROWS - 1).map((row, r) => (
            <tr key={r} className="border-b border-divider last:border-b-0">
              {row.map((cell, c) => (
                <td
                  key={c}
                  className="px-2.5 py-1 align-top whitespace-pre text-ink-700 tabular-nums"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > CSV_ROWS && (
        <p className="border-t border-divider px-2.5 py-1.5 text-[11.5px] text-muted">
          The first 1,000 rows. Download the file for the rest.
        </p>
      )}
    </div>
  );
}

function NotShown({ file, reason }: { file: Viewable; reason?: string }) {
  const ext = extensionOf(file.name).toUpperCase() || "FILE";
  return (
    <div className="grid max-w-[320px] justify-items-center gap-2.5 text-center text-[13px] text-ink-700">
      <ExtBadge name={file.name} />
      <b className="font-semibold [overflow-wrap:anywhere]">{file.name}</b>
      <span>
        {reason ??
          `A ${ext} file does not show in the CRM. Download it to open it in its own program.`}
      </span>
      <Button size="sm" onClick={() => download([file.downloadUrl])}>
        <Download size={14} />
        Download
      </Button>
    </div>
  );
}

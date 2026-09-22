import { useState } from "react";
import { FileText, Search } from "lucide-react";
import type { ChatFileItem, ChatMember } from "@shared/schema/chat";
import { fmtBytes, fmtDate } from "@/shared/lib/format";
import { useDebounced } from "@/shared/lib/use-debounced";
import { chatFileUrl } from "./attachments";
import { useChatFiles } from "./chat.api";
import { IconButton } from "@/shared/ui/button";
import { IconGoTo } from "@/shared/ui/icons";
import { RowButton } from "@/shared/ui/row-button";

/**
 * **The Files tab of a chat** (chat.md §6.4): the photos as a grid of previews and everything else
 * as a list, newest first, with a box over the names and a filter for who sent it.
 *
 * Names are searched as plain text, the way Files searches them: a file's name is not a message,
 * and it is not sealed (§9). What the words of a chat need is the message search, which is B.3.
 */
export function ChatFilesTab({
  chatId,
  members,
  open,
  onOpen,
  onGoToMessage,
}: {
  chatId: string;
  members: ChatMember[];
  /** asked for only while the tab is on screen */
  open: boolean;
  onOpen: (files: ChatFileItem[], index: number) => void;
  /**
   * **To the message the file came in** (owner, 2026-09-21: "можливість від файлу перейти до
   * повідомлення… як в телеграмі"). A file in this tab is out of its context; this is how somebody
   * gets back to what was being said when it was sent.
   */
  onGoToMessage: (messageId: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const [senderId, setSenderId] = useState("");
  const q = useDebounced(typed.trim(), 300);
  const files = useChatFiles(
    chatId,
    { q: q || undefined, senderId: senderId || undefined },
    open,
  );

  const rows = files.data?.files ?? [];
  const photos = rows.filter((f) => f.previewFileId !== null);
  const documents = rows.filter((f) => f.previewFileId === null);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search className="absolute top-2 left-2 size-3.5 text-muted" />
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Search by name"
          className="w-full rounded-(--radius-field) border border-border py-1.5 pr-2 pl-7 text-[13px] outline-none focus:border-primary"
        />
      </div>
      <select
        value={senderId}
        onChange={(e) => setSenderId(e.target.value)}
        className="w-full rounded-(--radius-field) border border-border px-2 py-1.5 text-[13px] outline-none focus:border-primary"
      >
        <option value="">Anybody</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.firstName} {m.lastName}
          </option>
        ))}
      </select>

      {files.isLoading && <p className="text-[12.5px] text-muted">Loading…</p>}
      {files.isError && (
        <p className="text-[12.5px] text-danger-text">The list did not load. Try again.</p>
      )}
      {!files.isLoading && !files.isError && rows.length === 0 && (
        <p className="text-[12.5px] text-muted">
          {q || senderId ? "Nothing matches." : "No files in this chat yet."}
        </p>
      )}

      {photos.length > 0 && (
        <section>
          <p className="mb-1 text-[11px] font-semibold text-muted uppercase">Photos</p>
          <div className="grid grid-cols-3 gap-1">
            {photos.map((file) => (
              <span key={file.fileId} className="group relative">
                <RowButton
                  title={`${file.name} · ${fmtBytes(file.size)}`}
                  onClick={() => onOpen(rows, rows.indexOf(file))}
                  className="aspect-square overflow-hidden rounded-(--radius-field) border border-border"
                >
                  <img
                    src={chatFileUrl(file.previewFileId!, "preview")}
                    alt={file.name}
                    loading="lazy"
                    className="size-full object-cover"
                  />
                </RowButton>
                <span className="absolute top-0.5 right-0.5 rounded-(--radius-btn-sm) bg-surface/85 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <IconButton
                    label="Go to the message it came in"
                    size="sm"
                    onClick={() => onGoToMessage(file.messageId)}
                  >
                    <IconGoTo />
                  </IconButton>
                </span>
              </span>
            ))}
          </div>
        </section>
      )}

      {documents.length > 0 && (
        <section>
          <p className="mb-1 text-[11px] font-semibold text-muted uppercase">Documents</p>
          <ul className="flex flex-col gap-1">
            {documents.map((file) => (
              // the row opens the file and the button beside it goes to the message, so the
              // button stands OUTSIDE the row: a button inside a button is not a control
              <li
                key={file.fileId}
                className="group flex items-center rounded-(--radius-field) border border-border pr-1"
              >
                <RowButton
                  onClick={() => onOpen(rows, rows.indexOf(file))}
                  className="min-w-0 flex-1 px-2 py-1.5 text-[12.5px]"
                >
                  <FileText className="size-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{file.name}</span>
                    <span className="block text-[11px] text-muted">
                      {fmtBytes(file.size)} · {fmtDate(file.at)}
                    </span>
                  </span>
                </RowButton>
                <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <IconButton
                    label="Go to the message it came in"
                    size="sm"
                    onClick={() => onGoToMessage(file.messageId)}
                  >
                    <IconGoTo />
                  </IconButton>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {files.data?.more && (
        <p className="text-[11.5px] text-muted">
          The newest 60 are shown. Search by name to find an older one.
        </p>
      )}
    </div>
  );
}

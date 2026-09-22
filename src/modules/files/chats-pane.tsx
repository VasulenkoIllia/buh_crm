import { useState } from "react";
import { Link } from "react-router-dom";
import type { ChatFilesRow } from "@shared/schema/chat";
import { FILE_KIND_LABEL, fileKind, type FileKind } from "@shared/file-kind";
import { useChatFiles, useChatFilesOverview } from "@/modules/chat";
import { cn } from "@/shared/lib/cn";
import { fmtBytes, fmtDate } from "@/shared/lib/format";
import { IconChat, IconFileInto, IconGoTo } from "@/shared/ui/icons";
import { IconButton } from "@/shared/ui/button";
import { RowButton } from "@/shared/ui/row-button";
import { KeepChatFileDialog } from "./dialogs";
import {
  CrumbTrail,
  EmptyState,
  Loading,
  PaneError,
  PaneFrame,
  type Crumb,
} from "./pane-parts";
import { useLibrary } from "./library-context";

/**
 * **Files sent in chats** (chat.md §6.5) — the one place that says where a year of conversation
 * went, and the answer to "куди зберігаються файли з чатів і де їх почистити" (owner, 2026-09-22).
 *
 * **It is a view, not a place.** A chat's file belongs to the messages that carry it and to nothing
 * in the library — a CHECK in the database holds that — so nothing here can be renamed, moved or
 * filed, exactly as Attachments cannot rename a task's file. What it offers instead is the two
 * things the owner asked for: seeing how much each conversation is holding, and getting to the
 * message so it can be dealt with there.
 *
 * **It shows only the reader's own chats**, because the server answers about nothing else. That is
 * deliberate and it is the whole reason this is safe to put on a screen the whole firm can open:
 * chat file NAMES are not sealed the way message text is, and a pane listing every chat in the firm
 * would be the admin reader of chats that chat.md §18 says was not built.
 *
 * **Why the figures here are smaller than Settings → System.** These count what a person can see
 * and act on: a photo's thumbnail is not listed, and a file forwarded into three chats is counted
 * in each of the three, because each of them really is holding it. The firm's own figure counts
 * every file once and the thumbnails with them. Two questions, two answers, both labelled.
 */

const share = (bytes: number, all: number) => (all > 0 ? Math.round((bytes / all) * 100) : 0);

/**
 * **A chat's name, in one place.** The tree and the pane both draw it, and writing it twice is
 * exactly how the channel came out as "Firm announcements" in one and "A group" in the other
 * (found by looking, 2026-09-22).
 */
export function chatName(row: ChatFilesRow): string {
  if (row.kind === "saved") return "Saved messages";
  if (row.kind === "announcements") return row.title ?? "Firm announcements";
  if (row.peer) return `${row.peer.firstName} ${row.peer.lastName}`.trim();
  return row.title ?? "A group";
}

export function ChatsPane() {
  const lib = useLibrary();
  const { data, error, isLoading } = useChatFilesOverview();

  const crumbs: Crumb[] = [{ key: "chats", label: "Chats" }];

  let body;
  if (error) body = <PaneError error={error} />;
  else if (isLoading || !data) body = <Loading />;
  else if (data.chats.length === 0) {
    body = (
      <EmptyState icon={<IconChat size={20} />} title="No files in your chats">
        A file sent in a chat shows up here, under the conversation it was sent in.
      </EmptyState>
    );
  } else {
    body = (
      <ul>
        {data.chats.map((row) => (
          <li key={row.chatId}>
            <RowButton
              onClick={() => lib.go({ type: "chat", chatId: row.chatId })}
              className="gap-3 border-b border-divider px-5 py-2.5 text-[13px] last:border-0"
            >
              <IconChat size={15} className="flex-none text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{chatName(row)}</span>
                <span className="block truncate text-[11.5px] text-muted">
                  {row.byKind
                    .map((k) => `${FILE_KIND_LABEL[k.kind as FileKind] ?? k.kind} ${k.files}`)
                    .join(" · ")}
                </span>
              </span>
              <span className="flex-none text-[11.5px] text-muted-400 tabular-nums">
                {share(row.bytes, data.all.bytes)}%
              </span>
              <span className="w-24 flex-none text-right text-[12.5px] text-ink-700 tabular-nums">
                {fmtBytes(row.bytes)}
              </span>
            </RowButton>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <PaneFrame
      label="Chats"
      crumbs={<CrumbTrail parts={crumbs} />}
      note={
        <p className="text-[12px] text-muted">
          Files sent in your chats, by conversation. They live with the message that carries
          them: open one to see it, or go to the message to deal with it there.
        </p>
      }
    >
      {data && data.chats.length > 0 && (
        <p className="border-b border-divider px-5 py-2 text-[12px] text-muted">
          {data.all.files} files · {fmtBytes(data.all.bytes)} in all
        </p>
      )}
      {body}
    </PaneFrame>
  );
}

/**
 * One chat's files. The same read the chat's own Files tab uses, so opening a conversation here
 * costs nothing that was not already built — and the two lists can never disagree.
 */
export function ChatFilesPane({ chatId }: { chatId: string }) {
  const [keeping, setKeeping] = useState<{ fileId: string; name: string } | null>(null);
  const overview = useChatFilesOverview();
  const row = overview.data?.chats.find((c) => c.chatId === chatId);
  const { data, error, isLoading } = useChatFiles(chatId, {}, true);

  const crumbs: Crumb[] = [
    { key: "chats", label: "Chats", view: { type: "chats" } },
    { key: chatId, label: row ? chatName(row) : "A chat" },
  ];

  let body;
  if (error) body = <PaneError error={error} />;
  else if (isLoading || !data) body = <Loading />;
  else if (data.files.length === 0) {
    body = <EmptyState icon={<IconChat size={20} />} title="This chat holds no files" />;
  } else {
    body = (
      <ul>
        {data.files.map((file) => (
          <li
            key={file.fileId}
            className="flex items-center gap-3 border-b border-divider px-5 py-2.5 text-[13px] last:border-0"
          >
            <span
              className={cn(
                "flex-none rounded-(--radius-chip) bg-divider px-1.5 py-0.5 text-[10.5px]",
                "font-medium text-muted uppercase",
              )}
            >
              {FILE_KIND_LABEL[fileKind(file.detectedMime)].slice(0, 3)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{file.name}</span>
              <span className="block text-[11.5px] text-muted">{fmtDate(file.at)}</span>
            </span>
            <span className="w-20 flex-none text-right text-[12.5px] text-ink-700 tabular-nums">
              {fmtBytes(file.size)}
            </span>
            {/* keeping it is the one thing done HERE; deleting it is done where it lives, by
                deleting the message that carries it (chat.md §6.3) */}
            <IconButton
              label="Keep this in Files"
              size="sm"
              onClick={() => setKeeping({ fileId: file.fileId, name: file.name })}
            >
              <IconFileInto />
            </IconButton>
            <Link
              to={`/chat/${chatId}?m=${file.seq}`}
              title="Go to the message it came in"
              aria-label="Go to the message it came in"
              className="flex-none rounded-(--radius-btn-sm) p-1 text-muted hover:bg-hover hover:text-ink"
            >
              <IconGoTo size={15} />
            </Link>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <PaneFrame
      label="A chat's files"
      crumbs={<CrumbTrail parts={crumbs} />}
      note={
        row ? (
          <p className="text-[12px] text-muted">
            {row.files} files · {fmtBytes(row.bytes)} ·{" "}
            {row.byKind
              .map(
                (k) => `${FILE_KIND_LABEL[k.kind as FileKind] ?? k.kind} ${fmtBytes(k.bytes)}`,
              )
              .join(" · ")}
          </p>
        ) : undefined
      }
    >
      {body}
      {data?.more && (
        <p className="px-5 py-2.5 text-[11.5px] text-muted">
          The newest 60 are shown. The chat&apos;s own Files tab searches them by name.
        </p>
      )}
      {keeping && <KeepChatFileDialog file={keeping} onClose={() => setKeeping(null)} />}
    </PaneFrame>
  );
}

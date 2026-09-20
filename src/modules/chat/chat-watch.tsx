import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { ChatSummary } from "@shared/schema/chat";
import { useAuth } from "@/app/auth";
import { playChime } from "@/modules/notifications";
import { useChatPeople, useChats } from "./chat.api";
import { chatSettings } from "./notify-settings";
import { useRealtime } from "./use-realtime";

/**
 * **Being told about a message while looking at something else** (chat.md §10.1).
 *
 * Rendered once by the shell, so it holds the live connection open wherever a person is in the CRM
 * and can answer for the whole product: the unread count on the Chat item and in the tab's title, a
 * short sound, and a browser notification that names who and where and never the text, since a
 * notification can sit in the system's notification centre on a shared screen.
 *
 * **One tab tells, however many are open.** The tabs agree through a `BroadcastChannel`: the one
 * with the lowest id among those that answered in the last few seconds is the one that sounds and
 * shows. Without `BroadcastChannel` (a very old browser) every tab is its own leader, which is the
 * behaviour there was before.
 */

const TABS = "buh_crm.chat.tabs";
const HELLO_MS = 2_000;
const FORGET_MS = 6_000;

function useIsTellingTab(): boolean {
  const [leader, setLeader] = useState(true);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const me = crypto.randomUUID();
    const seen = new Map<string, number>();
    const channel = new BroadcastChannel(TABS);
    const decide = () => {
      const now = Date.now();
      for (const [id, at] of seen) if (now - at > FORGET_MS) seen.delete(id);
      setLeader([...seen.keys(), me].sort()[0] === me);
    };
    channel.onmessage = (event: MessageEvent<{ id: string; gone?: true }>) => {
      // a tab that closes says so, so the others do not wait out its last hello (review 2026-09-20)
      if (event.data.gone) seen.delete(event.data.id);
      else seen.set(event.data.id, Date.now());
      decide();
    };
    const hello = window.setInterval(() => {
      channel.postMessage({ id: me });
      decide();
    }, HELLO_MS);
    channel.postMessage({ id: me });
    const goodbye = () => channel.postMessage({ id: me, gone: true });
    window.addEventListener("pagehide", goodbye);
    return () => {
      window.removeEventListener("pagehide", goodbye);
      goodbye();
      window.clearInterval(hello);
      channel.close();
    };
  }, []);
  return leader;
}

/** "(3) buh_crm" while something is waiting (§10.1). */
function useTabTitle(unread: number) {
  const base = useRef(document.title.replace(/^\(\d+\)\s*/, ""));
  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) ${base.current}` : base.current;
  }, [unread]);
  // signing out takes this watcher off the page, and the count must go with it (found in use)
  useEffect(() => {
    const name = base.current;
    return () => {
      document.title = name;
    };
  }, []);
}

function nameFor(chat: ChatSummary, fallback: string): string {
  switch (chat.kind) {
    case "group":
      return chat.title ?? "a group";
    case "announcements":
      return "Firm announcements";
    case "saved":
      return "Saved messages";
    default:
      return chat.peer ? `${chat.peer.firstName} ${chat.peer.lastName}`.trim() : fallback;
  }
}

/** Who and where, never a word of what was said (§10.1). */
function headline(chat: ChatSummary, peopleName: string): string {
  if (chat.kind === "direct") return `New message from ${nameFor(chat, peopleName)}`;
  if (chat.kind === "saved") return "A note in Saved messages";
  return `${peopleName} in ${nameFor(chat, peopleName)}`;
}

export function ChatWatch() {
  const { user } = useAuth();
  // holds the live connection for the whole CRM, not only for the Chat screen
  useRealtime();
  const chats = useChats();
  const people = useChatPeople();
  const telling = useIsTellingTab();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const openChatId = pathname.startsWith("/chat/") ? pathname.slice("/chat/".length) : null;

  const rows = useMemo(() => chats.data ?? [], [chats.data]);
  const unread = rows.reduce((n, chat) => n + (chat.mutedUntil ? 0 : chat.unread), 0);
  useTabTitle(unread);

  /** what each chat's unread stood at a moment ago, so only a RISE is news */
  const before = useRef<Map<string, number> | null>(null);

  useEffect(() => {
    const now = new Map(rows.map((chat) => [chat.id, chat.unread]));
    const was = before.current;
    before.current = now;
    if (!was || !telling) return;

    const settings = chatSettings();
    for (const chat of rows) {
      const grew = chat.unread > (was.get(chat.id) ?? 0);
      if (!grew) continue;
      // the chat on screen in the window in front is being read, not missed
      if (chat.id === openChatId && !document.hidden) continue;
      // a muted chat still speaks when somebody named the reader (§10.1)
      if (chat.mutedUntil && !chat.mentioned) continue;
      const author = chat.lastMessage?.authorId;
      if (author && author === user?.id) continue;

      // who wrote it: the colleague list names them in a group, and `peer` does in a direct chat
      const wrote = (people.data ?? []).find((p) => p.id === author);
      const person = wrote?.firstName ?? chat.peer?.firstName ?? "Somebody";
      if (settings.sound) playChime();
      if (settings.browser && typeof Notification !== "undefined") {
        if (Notification.permission !== "granted") continue;
        const note = new Notification(headline(chat, person), {
          tag: chat.id,
          // no body: a notification can stay in the system's notification centre on a shared screen
        });
        note.onclick = () => {
          window.focus();
          navigate(`/chat/${chat.id}`);
          note.close();
        };
      }
    }
  }, [rows, people.data, telling, openChatId, navigate, user?.id]);

  return null;
}

/** The count the sidebar's Chat item shows (§10.1). */
export function useChatUnread(): number {
  const chats = useChats();
  return (chats.data ?? []).reduce((n, chat) => n + (chat.mutedUntil ? 0 : chat.unread), 0);
}

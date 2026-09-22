import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Copy,
  CornerUpLeft,
  CornerUpRight,
  Eye,
  Link2,
  Pencil,
  Pin,
  Trash2,
} from "lucide-react";
import type { ChatMessage } from "@shared/schema/chat";
import { cn } from "@/shared/lib/cn";
import { EmojiPicker } from "./emoji-picker";

/**
 * **What a message can be done to** (chat.md §5.2): the row of quick reactions, and the menu a
 * right-click — or a two-finger tap, or the ⋯ — opens over it, in the shape Telegram put people in
 * the habit of (owner, 2026-09-20).
 *
 * Its own file since the audit of 2026-09-20: the conversation is a list, and a list that also
 * holds a portal-drawn context menu and an emoji picker was 900 lines nobody could read in one go.
 */

const QUICK = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

export function ReactionPicker({
  onPick,
  onClose,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const [all, setAll] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", escape);
    };
  }, [onClose]);

  return (
    <div ref={box} className="relative">
      {all ? (
        <EmojiPicker onPick={onPick} onClose={onClose} />
      ) : (
        <div className="absolute top-5 right-0 z-20 flex gap-0.5 rounded-full border border-border bg-surface px-1.5 py-1 shadow-(--shadow-card)">
          {QUICK.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onPick(emoji)}
              className="rounded-full px-1 text-[16px] hover:bg-divider"
            >
              {emoji}
            </button>
          ))}
          <button
            type="button"
            aria-label="More emoji"
            onClick={() => setAll(true)}
            className="rounded-full px-1 text-[13px] text-muted hover:bg-divider hover:text-ink"
          >
            +
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * **What a person does with one message** (the owner's ask, 2026-09-20: "як в телеграмі"): a
 * right-click anywhere on the bubble, or the ⋯ beside it, opens this. Reply and a reaction stay on
 * the hover row too, because on a desktop one click beats two for the things people do most.
 */
export function MessageMenu({
  message,
  at,
  can,
  onClose,
  on,
}: {
  message: ChatMessage;
  /** where the pointer was, in the window's own coordinates */
  at: { x: number; y: number };
  can: { edit: boolean; delete: boolean; pin: boolean; readBy: boolean };
  onClose: () => void;
  on: {
    react: (emoji: string) => void;
    reply: () => void;
    forward: () => void;
    copy: () => void;
    link: () => void;
    pin: () => void;
    readBy: () => void;
    edit: () => void;
    remove: () => void;
  };
}) {
  const [all, setAll] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  /**
   * Where it actually fits. The menu is drawn into the BODY rather than into the row: a virtualised
   * row carries a `transform`, and a transform makes `position: fixed` measure from itself instead
   * of from the window — which is why the first version landed over the messages and was cut off by
   * the conversation's own scrolling (found in use, 2026-09-20).
   */
  const [place, setPlace] = useState({ left: at.x, top: at.y });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    // upwards when there is no room below, which is most of the time near the composer, and
    // always inside the window: a menu opened from the ⋯ of a row near the top went off it
    const wanted = at.y + height + margin > window.innerHeight ? at.y - height - margin : at.y;
    setPlace({
      left: Math.max(margin, Math.min(at.x, window.innerWidth - width - margin)),
      top: Math.max(margin, Math.min(wanted, window.innerHeight - height - margin)),
    });
  }, [at.x, at.y]);

  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    // a scroll of the CONVERSATION leaves the menu hanging where it was, so it closes — but a
    // scroll INSIDE it is somebody reading the emoji list, and closing on that made the list
    // unusable (audit, 2026-09-20)
    const scrolled = (event: WheelEvent) => {
      if (!box.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", escape);
    window.addEventListener("wheel", scrolled, { passive: true });
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("wheel", scrolled);
    };
  }, [onClose]);

  /**
   * **It is a menu to the keyboard too** (audit, 2026-09-20: it was reachable only with a pointer,
   * and every destructive act on a message lives in it). Opening it puts the focus on the first
   * action; the arrows, Home and End walk them; Escape and Tab close it and hand the focus back to
   * whatever opened it. The same behaviour `shared/ui/menu.tsx` has, written here because this one
   * opens at a POINT — a right-click, a two-finger tap — rather than under a trigger.
   */
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    const first = box.current?.querySelector<HTMLElement>("[data-menu-item]");
    first?.focus();
    return () => (opener.current as HTMLElement | null)?.focus?.();
  }, []);

  const walk = (event: React.KeyboardEvent) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End", "Tab"];
    if (!keys.includes(event.key)) return;
    if (event.key === "Tab") {
      onClose();
      return;
    }
    event.preventDefault();
    const items = [...(box.current?.querySelectorAll<HTMLElement>("[data-menu-item]") ?? [])];
    if (items.length === 0) return;
    const now = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (now + (event.key === "ArrowDown" ? 1 : items.length - 1) + items.length) %
            items.length;
    items[next]?.focus();
  };

  const item =
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink hover:bg-divider " +
    "outline-none focus-visible:bg-divider focus:bg-divider";
  const act = (run: () => void) => () => {
    run();
    onClose();
  };

  // **"More emoji" replaces the menu**, rather than opening inside it: the picker is 320px wide
  // with a scrolling grid, and the menu is a 200px box that clips what it holds — it showed as a
  // cut-off sliver nobody could scroll (audit, 2026-09-20)
  if (all) {
    return createPortal(
      <div
        ref={box}
        style={{ position: "fixed", left: place.left, top: place.top }}
        className="z-[60]"
      >
        <EmojiPicker
          inline
          onPick={(emoji) => act(() => on.react(emoji))()}
          onClose={onClose}
        />
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      ref={box}
      role="menu"
      aria-label="What to do with this message"
      onKeyDown={walk}
      style={{ position: "fixed", left: place.left, top: place.top }}
      className="z-[60] w-[200px] overflow-hidden rounded-(--radius-panel) border border-border bg-surface py-1 shadow-(--shadow-modal)"
    >
      {/* the reactions first, as they are in Telegram: most of the time that is what the menu is
          opened for (owner, 2026-09-20) */}
      {!all && (
        <div className="mb-1 flex items-center gap-0.5 border-b border-divider px-2 pb-1.5">
          {QUICK.map((emoji) => (
            <button
              key={emoji}
              type="button"
              data-menu-item
              onClick={act(() => on.react(emoji))}
              className="rounded-full px-1 text-[16px] outline-none hover:bg-divider focus-visible:bg-divider focus:bg-divider"
            >
              {emoji}
            </button>
          ))}
          <button
            type="button"
            data-menu-item
            aria-label="More emoji"
            onClick={() => setAll(true)}
            className="ml-auto rounded-full px-1.5 text-[13px] text-muted hover:bg-divider hover:text-ink"
          >
            +
          </button>
        </div>
      )}
      <button type="button" data-menu-item className={item} onClick={act(on.reply)}>
        <CornerUpLeft className="size-3.5" />
        Reply
      </button>
      <button type="button" data-menu-item className={item} onClick={act(on.forward)}>
        <CornerUpRight className="size-3.5" />
        Forward
      </button>
      {message.text && (
        <button type="button" data-menu-item className={item} onClick={act(on.copy)}>
          <Copy className="size-3.5" />
          Copy text
        </button>
      )}
      <button type="button" data-menu-item className={item} onClick={act(on.link)}>
        <Link2 className="size-3.5" />
        Copy link
      </button>
      {can.pin && (
        <button type="button" data-menu-item className={item} onClick={act(on.pin)}>
          <Pin className="size-3.5" />
          {message.pinned ? "Unpin" : "Pin"}
        </button>
      )}
      {can.readBy && (
        <button type="button" data-menu-item className={item} onClick={act(on.readBy)}>
          <Eye className="size-3.5" />
          Read by
        </button>
      )}
      {can.edit && (
        <button type="button" data-menu-item className={item} onClick={act(on.edit)}>
          <Pencil className="size-3.5" />
          Edit
        </button>
      )}
      {can.delete && (
        <button
          type="button"
          data-menu-item
          className={cn(item, "text-danger-text")}
          onClick={act(on.remove)}
        >
          <Trash2 className="size-3.5" />
          Delete
        </button>
      )}
    </div>,
    document.body,
  );
}

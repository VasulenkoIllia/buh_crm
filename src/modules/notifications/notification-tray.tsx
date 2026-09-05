import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell } from "lucide-react";
import { notificationPath } from "@shared/notifications";
import { cn } from "@/shared/lib/cn";
import {
  useDismissAllNotifications,
  useDismissNotification,
  useNotificationChime,
  useNotifications,
} from "./notifications.api";

/**
 * The bell, and the panel under it.
 *
 * Two deliberate divergences from the prototype, both recorded for S12.5 Design QA:
 *
 *  1. The prototype puts the bell in the SIDEBAR. Ours is in the header, where the button has sat
 *     as a dead affordance since S1 — an `aria-label` and no handler. The header is where users
 *     now look, so the prototype is not followed here.
 *  2. The prototype REMOVES a dismissed row. We stamp `readAt` and hide it instead. The gesture
 *     feels identical, nothing is destroyed, and it is what gives the 90-day retention purge
 *     something to count from.
 *
 * There is no history screen and no paging: twenty unread rows, newest first, and anything older
 * is found through the task, meeting or invoice it was about (decided 2026-09-05).
 */

export function NotificationTray() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { data } = useNotifications();
  const unread = data?.unread ?? 0;
  // the bell is mounted once, in the app shell, so this is the one place the chime can live
  // without either firing twice or depending on which screen is open
  useNotificationChime();

  // click-away and Escape. Bound only while the panel is open, so a closed tray costs nothing.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        className={cn(
          "relative rounded-full p-2 text-muted hover:bg-divider",
          open && "bg-divider text-ink",
        )}
        aria-label={unread ? `Notifications (${unread} unread)` : "Notifications"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Bell size={18} />
        {unread > 0 && (
          <span
            className="absolute top-1 right-1 min-w-[15px] rounded-full bg-danger px-[3px] text-center text-[9px] leading-[15px] font-semibold text-white"
            aria-hidden
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && <TrayPanel onClose={() => setOpen(false)} />}
    </div>
  );
}

const PAGE = 20;

function TrayPanel({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [limit, setLimit] = useState(PAGE);
  const { data, isLoading } = useNotifications(limit);
  const dismiss = useDismissNotification();
  const dismissAll = useDismissAllNotifications();
  const items = data?.items ?? [];

  const openRow = (id: string, linkType: string | null, linkId: string | null) => {
    const path = notificationPath(linkType, linkId);
    // dismissed either way: opening it IS reading it. Not awaited — the navigation must not wait
    // on a write whose only job is to hide a row the person is already leaving behind.
    void dismiss.mutateAsync(id).catch(() => {});
    onClose();
    if (path) navigate(path);
  };

  return (
    <div
      className="absolute right-0 z-40 mt-2 w-[260px] overflow-hidden rounded-(--radius-panel) bg-surface shadow-[0_10px_34px_rgba(0,0,0,0.28)]"
      role="dialog"
      aria-label="Notifications"
    >
      <div className="flex items-center justify-between border-b border-[#eef0f3] px-3.5 py-[11px]">
        <span className="text-[12px] font-bold text-ink-700">Notifications</span>
        {items.length > 0 && (
          <button
            type="button"
            className="text-[11px] text-faint hover:text-ink-700 disabled:opacity-50"
            disabled={dismissAll.isPending}
            onClick={() => void dismissAll.mutateAsync().catch(() => {})}
          >
            Mark all read
          </button>
        )}
      </div>

      {isLoading && <Empty>Loading…</Empty>}
      {!isLoading && items.length === 0 && <Empty>No new notifications</Empty>}

      <div className="max-h-[60vh] overflow-y-auto">
        {items.map((n) => (
          <div key={n.id} className="flex gap-[9px] border-b border-divider px-3.5 py-[11px]">
            <Bell size={14} className="mt-[2px] shrink-0 text-faint" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] leading-[1.35] font-medium break-words text-ink">
                {n.text}
              </p>
              {n.sub && <p className="mt-[2px] text-[11px] break-words text-faint">{n.sub}</p>}
              <div className="mt-2 flex items-center gap-2.5">
                <button
                  type="button"
                  className="rounded-(--radius-btn-sm) border border-[#cdd7f7] bg-[#eef1fb] px-[11px] py-[5px] text-[11px] font-semibold text-primary-link"
                  onClick={() => openRow(n.id, n.linkType, n.linkId)}
                >
                  Open
                </button>
                <button
                  type="button"
                  className="text-[11px] text-faint hover:text-ink-700"
                  onClick={() => void dismiss.mutateAsync(n.id).catch(() => {})}
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        ))}
        {/*
          The tray was a hard cap of twenty, and on the first production forecast one admin would
          have woken to 24 unread with no screen able to reach four of them. Still the tray, still
          unread only, still newest first — just not a wall any more.
        */}
        {data && data.unread > items.length && (
          <button
            type="button"
            className="w-full px-3.5 py-2.5 text-[11.5px] font-medium text-primary-link hover:bg-divider"
            onClick={() => setLimit((n) => n + PAGE)}
          >
            Show {Math.min(PAGE, data.unread - items.length)} more
          </button>
        )}
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-3.5 py-4 text-center text-[12px] text-faint">{children}</p>;
}

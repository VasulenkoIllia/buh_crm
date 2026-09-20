import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/shared/lib/cn";

/**
 * **Every emoji, with a search, loaded only when the picker opens** (decision 15).
 *
 * The list is a data package of about 1,900 emoji; importing it here would put it in the chat's
 * chunk for everybody, so it is fetched on the first open and kept for the rest of the visit. The
 * ones a person actually uses are remembered on their own computer.
 */

interface Entry {
  emoji: string;
  name: string;
  slug: string;
}

type Groups = [string, Entry[]][];

let loaded: Groups | null = null;

async function load(): Promise<Groups> {
  const data = (await import("unicode-emoji-json/data-by-group.json")).default;
  loaded ??= data.map((group) => [
    group.name,
    group.emojis.map((e) => ({ emoji: e.emoji, name: e.name, slug: e.slug })),
  ]);
  return loaded;
}

const RECENT_KEY = "chat.emoji.recent";

function recent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]).slice(0, 24) : [];
  } catch {
    return [];
  }
}

function rememberEmoji(emoji: string) {
  try {
    const next = [emoji, ...recent().filter((e) => e !== emoji)].slice(0, 24);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // a browser with storage switched off still picks emoji, it just forgets them
  }
}

export function EmojiPicker({
  onPick,
  onClose,
  /** placed by whoever renders it, rather than above the composer's own button */
  inline = false,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
  inline?: boolean;
}) {
  const [groups, setGroups] = useState<Groups | null>(loaded);
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void load().then(setGroups);
  }, []);

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

  const shown = useMemo(() => {
    if (!groups) return [];
    const words = query.trim().toLowerCase();
    if (!words) {
      const mine = recent();
      const recentGroup: Groups = mine.length
        ? [["Recent", mine.map((emoji) => ({ emoji, name: emoji, slug: emoji }))]]
        : [];
      return [...recentGroup, ...groups];
    }
    const hits = groups
      .flatMap(([, list]) => list)
      .filter((e) => e.name.includes(words) || e.slug.includes(words))
      .slice(0, 120);
    return [["Found", hits]] as Groups;
  }, [groups, query]);

  return (
    <div
      ref={box}
      className={cn(
        "w-[320px] rounded-(--radius-panel) border border-border bg-surface shadow-(--shadow-card)",
        // above the composer's own button by default; the message menu places it itself, and a
        // picker positioned against a 200px menu with `overflow-hidden` was a clipped sliver
        // nobody could scroll (audit, 2026-09-20)
        inline ? "relative" : "absolute right-0 bottom-11 z-20",
      )}
    >
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search emoji"
        className="w-full rounded-t-(--radius-panel) border-b border-divider px-3 py-2 text-[13px] outline-none"
      />
      <div className="max-h-[260px] overflow-y-auto p-2">
        {!groups && <p className="px-1 py-2 text-[12px] text-muted">Loading…</p>}
        {groups && shown.every(([, list]) => list.length === 0) && (
          <p className="px-1 py-2 text-[12px] text-muted">Nothing found.</p>
        )}
        {shown.map(([name, list]) =>
          list.length === 0 ? null : (
            <div key={name} className="mb-2">
              <p className="mb-1 px-1 text-[11px] font-semibold text-muted uppercase">{name}</p>
              <div className="grid grid-cols-8 gap-0.5">
                {list.map((entry, i) => (
                  <button
                    key={`${entry.emoji}-${i}`}
                    type="button"
                    title={entry.name}
                    onClick={() => {
                      rememberEmoji(entry.emoji);
                      onPick(entry.emoji);
                    }}
                    className={cn(
                      "rounded p-1 text-[20px] leading-none hover:bg-divider",
                      "focus:bg-divider focus:outline-none",
                    )}
                  >
                    {entry.emoji}
                  </button>
                ))}
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

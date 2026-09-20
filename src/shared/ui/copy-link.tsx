import { useEffect, useRef, useState } from "react";
import { Check, Link2 } from "lucide-react";
import { cn } from "@/shared/lib/cn";

/**
 * **Copy the link to what is open** — ONE icon, in the same corner, on every record (owner,
 * 2026-09-20: "краще що б це всюди була іконка… в правому верхньому кутку… що б був один вигляд").
 *
 * It lives in a modal's `actions` slot, beside the ×, or at the right of a page's own header. The
 * chat draws whatever is pasted as that record's card (`shared/ui/record-card.tsx`).
 *
 * **The chain, not a paperclip**, deliberately: the paperclip already means "attach a file" in the
 * composer, and one icon with two meanings is how an interface stops being readable.
 *
 * On a copy the icon turns green, the word appears beside it, and both fade out on their own. A
 * button that answers nothing reads as a button that did not work; a button that answers for ever
 * reads as a state.
 */
export function CopyLink({
  href,
  label = "Copy link",
}: {
  href: string;
  /** what the button says to a screen reader and on hover; the copy itself never changes */
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = () => {
    void navigator.clipboard?.writeText(`${window.location.origin}${href}`).then(() => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? "Copied" : label}
      aria-label={copied ? "Copied" : label}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-(--radius-btn-sm) p-1 text-[11.5px] transition-colors",
        copied ? "text-success" : "text-muted hover:bg-hover hover:text-ink",
      )}
    >
      {copied ? <Check size={16} /> : <Link2 size={16} />}
      {copied && <span>Copied</span>}
    </button>
  );
}

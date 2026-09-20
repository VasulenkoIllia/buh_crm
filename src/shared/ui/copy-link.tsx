import { useState } from "react";
import { Link2 } from "lucide-react";
import { Button } from "./button";

/**
 * **Copy the link to what is open** — the same button on every record, so a task, an invoice, a
 * meeting and a lead are all sent to a colleague the same way (owner, 2026-09-20). The chat draws
 * whatever is pasted as that record's card (`shared/ui/record-card.tsx`).
 *
 * `href` is the record's own address, which is also what the address bar shows while it is open.
 */
export function CopyLink({ href, label = "Copy link" }: { href: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="text"
      onClick={() => {
        void navigator.clipboard?.writeText(`${window.location.origin}${href}`).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      <Link2 className="size-3.5" />
      {copied ? "Link copied" : label}
    </Button>
  );
}

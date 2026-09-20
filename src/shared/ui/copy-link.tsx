import { useState } from "react";
import { Check, Link2 } from "lucide-react";
import { Button, IconButton } from "./button";

/**
 * **Copy the link to what is open** — the same button on every record, so a task, an invoice, a
 * meeting, a lead, a client and a file are all sent to a colleague the same way (owner,
 * 2026-09-20). The chat draws whatever is pasted as that record's card
 * (`shared/ui/record-card.tsx`).
 *
 * `href` is the record's own address, which is also what the address bar shows while it is open.
 *
 * Two shapes, because the headers it stands in are not all alike: the word, beside other words,
 * and `icon` beside other icons. Both say the same thing when they have copied, because a button
 * that does nothing visible reads as a button that did not work.
 */
export function CopyLink({
  href,
  label = "Copy link",
  icon = false,
}: {
  href: string;
  label?: string;
  /** drawn as an icon, for a header that is a row of icons */
  icon?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(`${window.location.origin}${href}`).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  };

  if (icon) {
    return (
      <IconButton label={copied ? "Link copied" : label} onClick={copy}>
        {copied ? <Check size={15} /> : <Link2 size={15} />}
      </IconButton>
    );
  }

  return (
    <Button variant="text" onClick={copy}>
      <Link2 className="size-3.5" />
      {copied ? "Link copied" : label}
    </Button>
  );
}

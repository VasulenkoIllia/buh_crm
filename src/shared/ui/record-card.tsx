import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ApiError } from "@/shared/lib/api";
import { cn } from "@/shared/lib/cn";
import { kindOf, type CrmKind, type CrmLink } from "@/shared/lib/crm-links";
import {
  IconCampaign,
  IconChat,
  IconClient,
  IconFile,
  IconFolder,
  IconInvoice,
  IconLead,
  IconLetter,
  IconLocked,
  IconMeeting,
  IconSecret,
  IconService,
  IconTask,
  IconTemplate,
  IconUnavailable,
} from "@/shared/ui/icons";

/**
 * **A link into this CRM, drawn as the record it points at** — one card for every kind, so a task,
 * a client, an invoice, a meeting, a lead and a file look and behave the same wherever they are
 * shown (owner, 2026-09-20: "що б все було в одному стилі і однаково виглядали").
 *
 * **The card is always there.** When the reader may not see the record, it says so instead of
 * naming it, and clicking still goes to the record's own screen, which refuses properly and in its
 * own words. That is the owner's rule: the card is part of the conversation, the access is the
 * record's business.
 *
 * **It is a link, not a button** (audit, 2026-09-20), so a colleague can open a task in a new tab
 * with cmd-click the way they would anywhere else — and when a message is nothing but a link, the
 * card is the only thing on screen, which makes that the only way.
 */

// the meanings, not the pictures: `shared/ui/icons.ts` is the vocabulary, and a card that drew its
// own would drift away from the rest of the CRM the first time one of them changed (audit, 2026-09-21)
const ICONS: Record<CrmKind, typeof IconTask> = {
  task: IconTask,
  client: IconClient,
  lead: IconLead,
  invoice: IconInvoice,
  meeting: IconMeeting,
  file: IconFile,
  secret: IconSecret,
  chat: IconChat,
  mailout: IconLetter,
  campaign: IconCampaign,
  service: IconService,
  template: IconTemplate,
  person: IconClient,
  folder: IconFolder,
};

/**
 * What went wrong, in the card's own words. A refusal and a record that is gone are different
 * things to a reader, and a server that is simply down is neither: all three used to read "You do
 * not have access", which sent people asking for permissions they already had (audit, 2026-09-20).
 */
function trouble(error: unknown): { note: string; icon: typeof IconLocked } {
  const status = error instanceof ApiError ? error.status : 0;
  if (status === 403) return { note: "You do not have access", icon: IconLocked };
  if (status === 404) return { note: "Not found, or not open to you", icon: IconLocked };
  return { note: "Could not be loaded", icon: IconUnavailable };
}

export function RecordCard({
  link,
  /** drawn on the reader's own chat bubble, which is the primary colour */
  onPrimary = false,
}: {
  link: CrmLink;
  onPrimary?: boolean;
}) {
  const spec = kindOf(link.kind);
  const query = link.to.includes("?") ? link.to.slice(link.to.indexOf("?")) : "";
  const record = useQuery({
    // the query is part of the key: `?person=A` and `?person=B` on one client are two cards
    queryKey: ["crm-link", link.kind, link.id, query],
    queryFn: () => spec.ask(link.id, new URLSearchParams(query)),
    // refused means refused: the card says so rather than asking again four times
    retry: false,
    staleTime: 5 * 60_000,
  });

  const wrong = record.isError ? trouble(record.error) : null;
  const Icon = wrong ? wrong.icon : ICONS[link.kind];
  const name = record.data?.name ?? (wrong ? spec.label : "…");
  const note = wrong ? wrong.note : (record.data?.note ?? (record.isLoading ? "" : spec.label));

  return (
    <Link
      // **where the link itself points**, not where this kind's address is rebuilt from an id: a
      // link to a person inside a client is `/clients/<id>?tab=people&person=<id>`, and rebuilding
      // it dropped everything after the client and landed on Profile (owner, 2026-09-21)
      to={link.to}
      title={`${spec.label}: ${record.data?.name ?? link.url}`}
      className={cn(
        "mt-1 flex w-full items-center gap-2 rounded-(--radius-field) border px-2 py-1.5 text-left",
        onPrimary ? "border-white/40 hover:bg-white/10" : "border-border hover:bg-divider",
        record.data?.settled && "opacity-75",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium">{name}</span>
        <span
          className={cn(
            "block truncate text-[11px]",
            onPrimary ? "text-white/80" : "text-muted",
          )}
        >
          {[record.data ? spec.label : null, note].filter(Boolean).join(" · ")}
        </span>
      </span>
    </Link>
  );
}

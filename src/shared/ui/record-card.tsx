import { useQuery } from "@tanstack/react-query";
import {
  CalendarDays,
  CircleSlash,
  FileText,
  Lock,
  ListTodo,
  Receipt,
  Sparkles,
  UserRound,
} from "lucide-react";
import { Link } from "react-router-dom";
import { ApiError } from "@/shared/lib/api";
import { cn } from "@/shared/lib/cn";
import { kindOf, type CrmKind, type CrmLink } from "@/shared/lib/crm-links";

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

const ICONS: Record<CrmKind, typeof ListTodo> = {
  task: ListTodo,
  client: UserRound,
  lead: Sparkles,
  invoice: Receipt,
  meeting: CalendarDays,
  file: FileText,
};

/**
 * What went wrong, in the card's own words. A refusal and a record that is gone are different
 * things to a reader, and a server that is simply down is neither: all three used to read "You do
 * not have access", which sent people asking for permissions they already had (audit, 2026-09-20).
 */
function trouble(error: unknown): { note: string; icon: typeof Lock } {
  const status = error instanceof ApiError ? error.status : 0;
  if (status === 403) return { note: "You do not have access", icon: Lock };
  if (status === 404) return { note: "Not found, or not open to you", icon: Lock };
  return { note: "Could not be loaded", icon: CircleSlash };
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
  const record = useQuery({
    queryKey: ["crm-link", link.kind, link.id],
    queryFn: () => spec.ask(link.id),
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
      to={spec.href(link.id)}
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

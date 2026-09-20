import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ListTodo, UserRound } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "@/shared/lib/api";
import { cn } from "@/shared/lib/cn";

/**
 * **A link to this CRM, shown as the record it points at** (chat.md §5.6, decision 11): a task's
 * title, a client's name — so a colleague reads "Reminder check" rather than a line of uuid.
 *
 * **The reader's own browser asks, through the record's OWN route.** The chat adds nothing that
 * reads another module's records, and nothing is resolved on the server: the task route is behind
 * the `tasks` gate and the client route is `shared()`, so whoever may see the record sees its name
 * and whoever may not is left with the plain link that is already in the text. A link to anywhere
 * else on the internet stays a plain link — the server never fetches a URL, so there is no preview,
 * nothing leaves the network, and nothing can be made to fetch something inside it.
 */

type Kind = "task" | "client";

export interface CrmLink {
  kind: Kind;
  id: string;
  url: string;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const LINKS: { kind: Kind; pattern: RegExp }[] = [
  { kind: "task", pattern: new RegExp(`^/tasks\\?task=(${UUID})$`, "i") },
  { kind: "client", pattern: new RegExp(`^/clients/(${UUID})$`, "i") },
];

/** The CRM links in a message, in the order they appear, at most two — a message is not a list. */
export function crmLinksIn(text: string): CrmLink[] {
  const out: CrmLink[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>()]+[^\s<>().,;:!?]/g)) {
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    // this CRM alone: another site's link is a link, and the server never fetches one
    if (url.origin !== window.location.origin) continue;
    for (const { kind, pattern } of LINKS) {
      const found = pattern.exec(`${url.pathname}${url.search}`);
      if (found && !out.some((l) => l.id === found[1])) {
        out.push({ kind, id: found[1], url: match[0] });
      }
    }
    if (out.length === 2) break;
  }
  return out;
}

interface Named {
  name: string;
  note: string | null;
  done?: boolean;
}

async function nameOf(link: CrmLink): Promise<Named> {
  if (link.kind === "task") {
    const task = await api<{ title: string; done: boolean; cancelledAt: string | null }>(
      `/api/tasks/${link.id}`,
    );
    return {
      name: task.title,
      note: task.cancelledAt ? "Cancelled" : task.done ? "Done" : null,
      done: task.done || task.cancelledAt !== null,
    };
  }
  const client = await api<{
    firstName: string;
    lastName: string | null;
    companyName: string | null;
    code: number;
  }>(`/api/clients/${link.id}`);
  return {
    name: [client.firstName, client.lastName].filter(Boolean).join(" "),
    note: client.companyName ?? `C-${client.code}`,
  };
}

export function CrmLinkCard({ link, mine }: { link: CrmLink; mine: boolean }) {
  const navigate = useNavigate();
  const record = useQuery({
    queryKey: ["chat", "crm-link", link.kind, link.id],
    queryFn: () => nameOf(link),
    // a record the reader may not open answers 403 or 404: the plain link in the text is the answer
    retry: false,
    staleTime: 5 * 60_000,
  });
  if (!record.data) return null;

  const Icon = link.kind === "client" ? UserRound : record.data.done ? CheckCircle2 : ListTodo;
  return (
    <button
      type="button"
      onClick={() => navigate(`${new URL(link.url).pathname}${new URL(link.url).search}`)}
      className={cn(
        "mt-1 flex w-full items-center gap-2 rounded-(--radius-field) border px-2 py-1.5 text-left",
        mine ? "border-white/40 hover:bg-white/10" : "border-border hover:bg-divider",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium">{record.data.name}</span>
        <span className={cn("block text-[11px]", mine ? "text-white/80" : "text-muted")}>
          {[link.kind === "task" ? "Task" : "Client", record.data.note]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
    </button>
  );
}

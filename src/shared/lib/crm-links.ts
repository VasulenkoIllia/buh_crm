import { api } from "./api";

/**
 * **Every link into this CRM, in one place** (chat.md §5.6; owner, 2026-09-20: "таке посилання має
 * працювати на все в нашому проекті … і передбачити майбутні модулі").
 *
 * A link a person pastes — into a chat message today, into anything else tomorrow — is matched
 * here, and whatever matched is drawn by one component (`shared/ui/record-card.tsx`), so a task, a
 * client, an invoice, a meeting, a lead and a file all look the same and behave the same.
 *
 * **Adding a module is one entry**: its address, the read that names its record, and an icon. The
 * three rules the entry must keep are the ones that make this safe:
 *
 * 1. **The reader's own browser asks, through the record's OWN route.** Nothing here resolves on
 *    the server, and nothing adds a route that reads another module's records — the record's gate
 *    and rules are the same ones its own screen obeys.
 * 2. **A name is shown only to somebody who may see it.** When the read is refused the card still
 *    appears, saying what the link is and that the reader has no access; a name is exactly what a
 *    closed gate protects ("Petrenko audit letter.pdf" is not something to leak into a chat).
 * 3. **This CRM only.** A link anywhere else is a link: the server never fetches a URL, so there is
 *    no preview of other sites, nothing leaves the network, and nothing can be made to fetch
 *    something inside it.
 */

export type CrmKind =
  | "task"
  | "client"
  | "lead"
  | "invoice"
  | "meeting"
  | "file"
  | "secret"
  | "chat"
  | "mailout"
  | "campaign"
  | "service"
  | "template"
  | "person";

/** What a card shows once the record has answered. */
export interface RecordName {
  name: string;
  /** one line under it: a state, a client, a date — whatever this kind is best said by */
  note: string | null;
  /** drawn in a quieter way: done, cancelled, paid — a record nobody has to act on */
  settled?: boolean;
}

export interface CrmLinkKind {
  kind: CrmKind;
  /** what it is, in the card's second line, when there is nothing better to say */
  label: string;
  /** where clicking it goes, which is the address it came from */
  href: (id: string) => string;
  /** the record this URL of ours names, or null; see `byParam`/`byPath` below */
  idIn: (url: URL) => string | null;
  /**
   * The record's OWN read; it throws when this reader may not see it, and that is the answer.
   *
   * `query` is what the link carried after its path, for the kinds where a link can point at a
   * PART of a record — a client's contact person, a task's comment one day. Most kinds ignore it.
   */
  ask: (id: string, query?: URLSearchParams) => Promise<RecordName>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const path = (url: URL) => url.pathname.replace(/\/+$/, "") || "/";

/**
 * **A record named by a query parameter** — `/billing?invoice=<id>`, written by `useRecordParam`.
 *
 * It reads the ONE parameter and ignores the rest, because a page keeps its filters in the address
 * beside it: what a person copies out of the address bar is `?status=owed&invoice=<id>`, and a card
 * that only matched the bare form would be missing exactly when somebody used the screen first.
 */
const byParam =
  (where: string, name: string) =>
  (url: URL): string | null => {
    if (path(url) !== where) return null;
    const id = url.searchParams.get(name);
    return id && UUID.test(id) ? id.toLowerCase() : null;
  };

/** A record named by the address itself — `/clients/<id>`, a screen of its own. */
const byPath =
  (where: string) =>
  (url: URL): string | null => {
    const rest = path(url).startsWith(`${where}/`) ? path(url).slice(where.length + 1) : null;
    return rest && UUID.test(rest) ? rest.toLowerCase() : null;
  };

const money = (amount: number) => `${(amount / 100).toFixed(2)}`;

export const CRM_LINKS: CrmLinkKind[] = [
  {
    kind: "task",
    label: "Task",
    href: (id) => `/tasks?task=${id}`,
    idIn: byParam("/tasks", "task"),
    ask: async (id) => {
      const task = await api<{ title: string; done: boolean; cancelledAt: string | null }>(
        `/api/tasks/${id}`,
      );
      return {
        name: task.title,
        note: task.cancelledAt ? "Cancelled" : task.done ? "Done" : null,
        settled: task.done || task.cancelledAt !== null,
      };
    },
  },
  {
    kind: "client",
    label: "Client",
    href: (id) => `/clients/${id}`,
    idIn: byPath("/clients"),
    /**
     * A link may point INSIDE a client — at a company, a contact person, a subscription — and then
     * the card names THAT, with the client under it (owner, 2026-09-21: "посилання на людину в
     * чаті посилання на клієнта а не на людину"). The child is named by the same read, which is
     * why this one takes the query along.
     */
    ask: async (id, query) => {
      // the card's own read, not the screen's: `/api/clients/:id` records a view, and a card is
      // drawn by scrolling past a message rather than by opening anything (audit, 2026-09-20)
      const inside = new URLSearchParams();
      for (const key of ["person", "company", "subscription"]) {
        const value = query?.get(key);
        if (value) inside.set(key, value);
      }
      const client = await api<{
        name: string;
        companyName: string | null;
        code: number;
        child: { kind: string; name: string } | null;
      }>(`/api/clients/${id}/card${inside.size ? `?${inside}` : ""}`);
      const under = client.companyName ?? `C-${client.code}`;
      return client.child
        ? { name: client.child.name, note: `${client.name} · ${client.child.kind}` }
        : { name: client.name, note: under };
    },
  },
  {
    kind: "lead",
    label: "Lead",
    href: (id) => `/leads?lead=${id}`,
    idIn: byParam("/leads", "lead"),
    ask: async (id) => {
      const lead = await api<{ name: string; companyName: string | null; stageName: string }>(
        `/api/leads/${id}`,
      );
      return { name: lead.name, note: lead.companyName ?? lead.stageName };
    },
  },
  {
    kind: "invoice",
    label: "Invoice",
    href: (id) => `/billing?invoice=${id}`,
    idIn: byParam("/billing", "invoice"),
    ask: async (id) => {
      const invoice = await api<{
        number: string;
        clientName: string;
        amount: number;
        status: string;
      }>(`/api/invoices/${id}`);
      return {
        name: `${invoice.number} · ${money(invoice.amount)}`,
        note: `${invoice.clientName} · ${invoice.status}`,
        settled: invoice.status === "paid" || invoice.status === "cancelled",
      };
    },
  },
  {
    kind: "meeting",
    label: "Meeting",
    href: (id) => `/calendar?meeting=${id}`,
    idIn: byParam("/calendar", "meeting"),
    ask: async (id) => {
      const meeting = await api<{
        title: string;
        startAt: string;
        cancelledAt?: string | null;
      }>(`/api/calendar/meetings/${id}`);
      const when = new Date(meeting.startAt);
      return {
        name: meeting.title,
        note: when.toLocaleString(undefined, {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        }),
        settled: !!meeting.cancelledAt || when.getTime() < Date.now(),
      };
    },
  },
  {
    kind: "file",
    label: "File",
    href: (id) => `/files?file=${id}`,
    idIn: byParam("/files", "file"),
    ask: async (id) => {
      const file = await api<{ name: string; size: number; where: string }>(
        `/api/files/${id}/card`,
      );
      return { name: file.name, note: `${file.where} · ${Math.ceil(file.size / 1024)} KB` };
    },
  },
  {
    kind: "secret",
    label: "Secret",
    href: (id) => `/secrets?secret=${id}`,
    idIn: byParam("/secrets", "secret"),
    /**
     * **The one card that does not name its record** (secrets.md §22). A secret's label is the
     * reconnaissance half of it — "Petrenko — IRS EFTPS" says which credentials exist for whom —
     * and a card is drawn by scrolling a message into view, with no unlock, for ever after in that
     * chat. So the card says where it lives and what kind it is, which is enough for "look at this
     * one", and the label is read on the vault's own screen by somebody who went there.
     */
    ask: async (id) => {
      const secret = await api<{ where: string; kind: string }>(`/api/secrets/${id}/card`);
      return { name: `${secret.kind} in ${secret.where}`, note: "Open the vault to see it" };
    },
  },
  {
    kind: "chat",
    label: "Chat",
    href: (id) => `/chat/${id}`,
    idIn: byPath("/chat"),
    ask: async (id) => {
      const chat = await api<{
        kind: string;
        title: string | null;
        peer: { firstName: string; lastName: string } | null;
        memberCount: number;
      }>(`/api/chat/chats/${id}`);
      const name =
        chat.kind === "group"
          ? (chat.title ?? "Group")
          : chat.kind === "saved"
            ? "Saved messages"
            : chat.kind === "announcements"
              ? "Firm announcements"
              : chat.peer
                ? `${chat.peer.firstName} ${chat.peer.lastName}`.trim()
                : "Direct chat";
      return { name, note: chat.kind === "group" ? `${chat.memberCount} people` : null };
    },
  },
  {
    kind: "mailout",
    label: "Mail-out",
    href: (id) => `/mailouts?tab=log&mailout=${id}`,
    idIn: byParam("/mailouts", "mailout"),
    /** the subject and the tally, never the recipients: who was written to is the screen's (§D) */
    ask: async (id) => {
      const sent = await api<{
        subject: string;
        counts: { sent: number; delivered: number; notDelivered: number };
      }>(`/api/mailouts/${id}`);
      const { sent: out, delivered, notDelivered } = sent.counts;
      return {
        name: sent.subject,
        note: `${out} sent · ${delivered} delivered${notDelivered ? ` · ${notDelivered} not` : ""}`,
        settled: true,
      };
    },
  },
  {
    kind: "campaign",
    label: "Campaign",
    href: (id) => `/mailouts?tab=campaigns&campaign=${id}`,
    idIn: byParam("/mailouts", "campaign"),
    ask: async (id) => {
      const campaign = await api<{
        name: string;
        status: string;
        recipientCount: number;
        nextRunOn: string | null;
      }>(`/api/mailouts/campaigns/${id}`);
      return {
        name: campaign.name,
        note: `${campaign.status} · ${campaign.recipientCount} people${
          campaign.nextRunOn ? ` · next ${campaign.nextRunOn}` : ""
        }`,
        settled: campaign.status !== "active",
      };
    },
  },
  {
    kind: "template",
    label: "Letter template",
    href: (id) => `/mailouts?tab=templates&template=${id}`,
    idIn: byParam("/mailouts", "template"),
    /** the templates are one small list behind the Mail-outs gate; no read of its own is needed */
    ask: async (id) => {
      const all = await api<{ id: string; name: string; subject: string }[]>(
        "/api/mailouts/templates",
      );
      const template = all.find((t) => t.id === id);
      if (!template) throw new Error("No such template");
      return { name: template.name, note: template.subject };
    },
  },
  {
    kind: "person",
    label: "Colleague",
    href: (id) => `/team?user=${id}`,
    idIn: byParam("/team", "user"),
    /**
     * The firm's own directory (`/api/tasks/assignees`), which is `shared()` and is what every
     * assignee picker in the CRM fills from — NOT `GET /api/users`, which is the Team screen's
     * and admin-only. A colleague's name is not something to hide from their colleagues; what is
     * admin-only is their email, their role and the acts on them, and none of that is here.
     */
    ask: async (id) => {
      const all =
        await api<{ id: string; firstName: string; lastName: string; status: string }[]>(
          "/api/tasks/assignees",
        );
      const person = all.find((p) => p.id === id);
      if (!person) throw new Error("No such colleague");
      return {
        name: `${person.firstName} ${person.lastName}`.trim(),
        note: person.status === "active" ? null : person.status,
        settled: person.status !== "active",
      };
    },
  },
  {
    kind: "service",
    label: "Service",
    href: (id) => `/services?service=${id}`,
    idIn: byParam("/services", "service"),
    /**
     * The catalog is one small `shared()` read the whole app already holds, so a service's card
     * costs no route of its own: it is found in the list.
     */
    ask: async (id) => {
      const catalog = await api<{
        services: { id: string; name: string; type: string; archivedAt?: string | null }[];
      }>("/api/catalog");
      const service = catalog.services.find((s) => s.id === id);
      if (!service) throw new Error("No such service");
      return {
        name: service.name,
        note: service.type,
        settled: !!service.archivedAt,
      };
    },
  },
];

export interface CrmLink {
  kind: CrmKind;
  id: string;
  /** the address as it was written, which is what the card shows on hover */
  url: string;
  /** where a click goes: this CRM's own path, with everything the link said after it */
  to: string;
}

/** Every CRM link in a piece of text, in the order they appear; at most two — a message is not a list. */
export function crmLinksIn(text: string): CrmLink[] {
  const out: CrmLink[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>()]+[^\s<>().,;:!?]/g)) {
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    // this CRM's own address and nothing else: the card is a read of OUR record, and a link
    // anywhere else stays a link (rule 3 above)
    if (url.origin !== window.location.origin) continue;
    for (const link of CRM_LINKS) {
      const id = link.idIn(url);
      if (id && !out.some((l) => l.id === id && l.kind === link.kind)) {
        out.push({
          kind: link.kind,
          id,
          url: match[0],
          // the path and the query as they were written: a link into a part of a record has to
          // arrive at that part, and only the link knows which part (owner, 2026-09-21)
          to: `${url.pathname}${url.search}`,
        });
      }
    }
    if (out.length >= 2) break;
  }
  return out.slice(0, 2);
}

/**
 * **Is this text nothing but CRM links?** Then the cards ARE the message and the URLs are not drawn
 * at all (owner, 2026-09-20). A sentence with a link inside it keeps its words.
 */
export function isOnlyCrmLinks(text: string): boolean {
  const links = crmLinksIn(text);
  if (links.length === 0) return false;
  let left = text;
  for (const link of links) left = left.split(link.url).join(" ");
  // a THIRD link is a link this message draws no card for: leaving the words in is what shows it,
  // and stripping only the two cards' urls left a bare address under two cards (audit, 2026-09-20)
  return left.trim() === "";
}

/** The cards a message shows, and whether its words are drawn at all. */
export function cardsIn(text: string): { links: CrmLink[]; wordsToo: boolean } {
  const links = crmLinksIn(text);
  return { links, wordsToo: links.length === 0 || !isOnlyCrmLinks(text) };
}

export const kindOf = (kind: CrmKind): CrmLinkKind =>
  CRM_LINKS.find((l) => l.kind === kind) as CrmLinkKind;

import { useEffect, useRef, useState } from "react";
import { Eye, RotateCcw, User } from "lucide-react";
import {
  SECRET_TEMPLATES,
  TEMPLATE_COPY,
  type SecretCrumb,
  type SecretRow,
  type SecretTemplate,
} from "@shared/schema/secrets";
import { cn } from "@/shared/lib/cn";
import { fmtDate, fmtDateTime } from "@/shared/lib/format";
import { Button } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";
import { ClientCode } from "@/shared/ui/client-code";
import { FilterChips, type TabOption } from "@/shared/ui/tabs";
import { COMPANY, MY, type UiPlace, type View } from "./places";
import {
  useClientNodes,
  usePlaceSecrets,
  useRestoreBatch,
  useRestoreSecret,
  useSearch,
  useTrash,
} from "./secrets.api";
import type { Openable } from "./entry";
import { TemplateIcon, summaryOf } from "./template-bits";

/** The frame every pane sits in, so the four of them line up. */
export function Pane({ head, children }: { head: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-(--radius-panel) border border-border bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="flex flex-col gap-2.5 border-b border-divider px-[18px] py-3.5">
        {head}
      </div>
      {children}
    </section>
  );
}

export const Empty = ({ title, note }: { title: string; note?: string }) => (
  <div className="grid justify-items-center gap-2 px-6 py-14 text-center text-[13px] text-muted">
    <b className="text-[14px] text-ink-700">{title}</b>
    {note && <span className="max-w-[420px]">{note}</span>}
  </div>
);

export const Loading = () => <p className="px-[18px] py-6 text-[13px] text-muted">Loading…</p>;
export const Failed = () => (
  <p className="px-[18px] py-6 text-[13px] text-danger-text">Failed to load.</p>
);

/** One secret in a list: what it is, who touched it last, and the way into it. */
function SecretRowView({
  secret,
  focused,
  selected,
  onToggle,
  onOpen,
}: {
  secret: SecretRow;
  focused?: boolean;
  selected?: boolean;
  onToggle?: () => void;
  onOpen: () => void;
}) {
  const row = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (focused) row.current?.scrollIntoView({ block: "center" });
  }, [focused]);
  const summary = summaryOf(secret);

  return (
    <tr
      ref={row}
      className={cn(
        "cursor-pointer border-b border-divider last:border-0 hover:bg-[#f7f8fa]",
        (focused || selected) && "bg-primary-soft hover:bg-primary-soft",
      )}
      onClick={onOpen}
    >
      {onToggle && (
        <td className="w-9 pl-[18px] align-middle" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={!!selected}
            aria-label={`Select ${secret.label}`}
            onChange={onToggle}
          />
        </td>
      )}
      <td className={cn("w-[58%] py-2 pr-3 align-middle", onToggle ? "pl-2" : "pl-[18px]")}>
        <div className="flex min-w-0 items-center gap-2.5">
          <TemplateIcon template={secret.template} />
          <div className="min-w-0">
            <span className="font-medium text-ink [overflow-wrap:anywhere]">
              {secret.label}
            </span>
            {!secret.hasValue && (
              <Chip tone="gray" size="sm" className="ml-1.5 align-[1px]">
                reference only
              </Chip>
            )}
            {/* a leaver's block moved it here, and whose it was stays visible (§8) */}
            {secret.movedFromName && (
              <Chip tone="amber" size="sm" className="ml-1.5 align-[1px]">
                from {secret.movedFromName}
              </Chip>
            )}
            <span className="block text-[11.5px] text-muted-400">
              {TEMPLATE_COPY[secret.template].label}
              {summary && ` · ${summary}`}
            </span>
          </div>
        </div>
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-[12.5px] text-ink-700">
        {secret.updatedByName && <span className="block">{secret.updatedByName}</span>}
        <span className="text-muted">{fmtDate(secret.updatedAt)}</span>
      </td>
      <td className="w-12 px-3 py-2 text-right">
        <Eye size={15} className="inline text-muted" aria-hidden />
      </td>
    </tr>
  );
}

export function SecretTable({
  rows,
  focus,
  selected,
  onToggle,
  onOpen,
}: {
  rows: SecretRow[];
  focus?: string;
  /** given only where a selection makes sense: one place's own list */
  selected?: Set<string>;
  onToggle?: (id: string) => void;
  onOpen: (secret: SecretRow) => void;
}) {
  const th =
    "border-b border-divider py-2.5 text-left text-[11.5px] font-semibold uppercase tracking-[.04em] text-muted-400";
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {onToggle && <th className={cn(th, "w-9 pl-[18px]")} />}
            <th className={cn(th, onToggle ? "pl-2 pr-3" : "px-[18px]")}>Name</th>
            <th className={cn(th, "px-3")}>Changed</th>
            <th className="border-b border-divider" />
          </tr>
        </thead>
        <tbody>
          {rows.map((secret) => (
            <SecretRowView
              key={secret.id}
              secret={secret}
              focused={focus === secret.id}
              selected={selected?.has(secret.id)}
              onToggle={onToggle ? () => onToggle(secret.id) : undefined}
              onOpen={() => onOpen(secret)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Filter chips by template, listing only the kinds this place actually holds. */
function TemplateFilter({
  rows,
  value,
  onChange,
}: {
  rows: SecretRow[];
  value: SecretTemplate | "all";
  onChange: (v: SecretTemplate | "all") => void;
}) {
  const kinds = SECRET_TEMPLATES.filter((t) => rows.some((r) => r.template === t));
  if (kinds.length < 2) return null;
  const options: TabOption<SecretTemplate | "all">[] = [
    { value: "all", label: "All", count: rows.length },
    ...kinds.map((t) => ({
      value: t,
      label: TEMPLATE_COPY[t].label,
      count: rows.filter((r) => r.template === t).length,
    })),
  ];
  return <FilterChips value={value} onChange={onChange} options={options} />;
}

/**
 * The leavers whose My secrets came into Company, as filter chips (§8): only when there are any,
 * because the badge is the rule and the filter is the way to find them all at once.
 */
function FromFilter({
  rows,
  value,
  onChange,
}: {
  rows: SecretRow[];
  value: string;
  onChange: (v: string) => void;
}) {
  const names = [...new Set(rows.flatMap((r) => (r.movedFromName ? [r.movedFromName] : [])))];
  if (names.length === 0) return null;
  const options: TabOption<string>[] = [
    { value: "", label: "Anyone's" },
    ...names.sort().map((name) => ({
      value: name,
      label: `From ${name}`,
      count: rows.filter((r) => r.movedFromName === name).length,
    })),
  ];
  return <FilterChips value={value} onChange={onChange} options={options} />;
}

/**
 * One place's list. A selection stays within it (§7), so it lives here and is gone the moment
 * another place opens.
 */
export function PlacePane({
  place,
  title,
  focus,
  template,
  onTemplate,
  onOpen,
  canMove,
  onMoveMany,
  onDeleteMany,
}: {
  place: UiPlace;
  title: React.ReactNode;
  focus?: string;
  template: SecretTemplate | "all";
  onTemplate: (v: SecretTemplate | "all") => void;
  onOpen: (secret: SecretRow) => void;
  /** false where only an admin may move, which is out of a client */
  canMove: boolean;
  onMoveMany: (ids: string[]) => void;
  onDeleteMany: (ids: string[], done: () => void) => void;
}) {
  const { data, error } = usePlaceSecrets(place);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [picked, setFrom] = useState("");
  const rows = data ?? [];
  // a leaver's filter that no longer matches anything (they were all moved on) filters nothing
  const from = rows.some((r) => r.movedFromName === picked) ? picked : "";
  const shown = rows.filter(
    (r) =>
      (template === "all" || r.template === template) && (!from || r.movedFromName === from),
  );
  // a selection only ever names what is still on screen
  const chosen = [...selected].filter((id) => rows.some((r) => r.id === id));

  const toggle = (id: string) =>
    setSelected((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Pane
      head={
        <>
          <div className="flex items-center gap-2 text-[13px] text-muted">{title}</div>
          <TemplateFilter rows={rows} value={template} onChange={onTemplate} />
          <FromFilter rows={rows} value={from} onChange={setFrom} />
        </>
      }
    >
      {chosen.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-divider bg-[#fafbfc] px-[18px] py-2 text-[12.5px]">
          <span className="font-semibold text-primary-link">{chosen.length} selected</span>
          <span className="flex-1" />
          {canMove && (
            <Button variant="secondary" size="sm" onClick={() => onMoveMany(chosen)}>
              Move
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onDeleteMany(chosen, () => setSelected(new Set()))}
          >
            Delete
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}
      {error ? (
        <Failed />
      ) : !data ? (
        <Loading />
      ) : shown.length === 0 ? (
        <Empty title="No secrets here yet" />
      ) : (
        <SecretTable
          rows={shown}
          focus={focus}
          selected={selected}
          onToggle={toggle}
          onOpen={onOpen}
        />
      )}
    </Pane>
  );
}

/** Every client with a list, and how much is in it: the way to one that holds none yet. */
export function ClientsPane({ onOpenClient }: { onOpenClient: (clientId: string) => void }) {
  const { data, error } = useClientNodes(true);
  return (
    <Pane
      head={
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <span className="font-semibold text-ink">Clients</span>
          <span>· one list per client</span>
          {data && <span className="ml-auto tabular-nums">{data.length} clients</span>}
        </div>
      }
    >
      {error ? (
        <Failed />
      ) : !data ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty title="No clients yet" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <tbody>
              {data.map((client) => (
                <tr
                  key={client.id}
                  className="cursor-pointer border-b border-divider last:border-0 hover:bg-[#f7f8fa]"
                  onClick={() => onOpenClient(client.id)}
                >
                  <td className="px-[18px] py-2">
                    <div className="flex items-center gap-2.5">
                      <span className="grid h-[30px] w-[30px] flex-none place-items-center rounded-[7px] bg-divider text-muted">
                        <User size={15} />
                      </span>
                      <span className="font-medium text-ink">{client.label}</span>
                      <ClientCode code={client.code} />
                    </div>
                  </td>
                  <td className="w-40 px-3 py-2 text-[12.5px] tabular-nums text-muted">
                    {client.secrets} {client.secrets === 1 ? "secret" : "secrets"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Pane>
  );
}

/**
 * **One box, over everything the reader may see** (§10). Clients come above the secrets, and every
 * step of a hit's path is a way there, the last one marking the secret in the list it opens.
 */
export function SearchPane({
  q,
  place,
  template,
  onPlace,
  onTemplate,
  onGo,
  onOpen,
}: {
  q: string;
  place: "all" | "my" | "company" | "clients";
  template: SecretTemplate | "all";
  onPlace: (v: "all" | "my" | "company" | "clients") => void;
  onTemplate: (v: SecretTemplate | "all") => void;
  onGo: (view: View) => void;
  onOpen: (secret: Openable, place: UiPlace) => void;
}) {
  const search = useSearch(q, {
    place: place === "all" ? undefined : place,
    template: template === "all" ? undefined : template,
  });
  const hits = search.data?.hits ?? [];
  const clients = search.data?.clients ?? [];

  const placeOfHit = (crumbs: SecretCrumb[]): UiPlace => {
    const last = crumbs[crumbs.length - 1]?.to;
    if (last?.type === "company") return COMPANY;
    if (last?.type === "client") return { kind: "client", clientId: last.clientId };
    return MY;
  };
  const goTo = (step: SecretCrumb, focus?: string) => {
    const to = step.to;
    if (to.type === "clients") return onGo({ type: "clients" });
    if (to.type === "client") {
      return onGo({ type: "place", place: { kind: "client", clientId: to.clientId }, focus });
    }
    onGo({ type: "place", place: to.type === "company" ? COMPANY : MY, focus });
  };

  const places: TabOption<"all" | "my" | "company" | "clients">[] = [
    { value: "all", label: "Everywhere" },
    { value: "my", label: "My secrets" },
    { value: "company", label: "Company" },
    { value: "clients", label: "Clients" },
  ];

  return (
    <Pane
      head={
        <>
          <div className="flex items-center gap-2 text-[13px] text-muted">
            <span className="font-semibold text-ink">Search</span>
            <span>
              · {hits.length} {hits.length === 1 ? "secret" : "secrets"}
              {clients.length > 0 &&
                `, ${clients.length} ${clients.length === 1 ? "client" : "clients"}`}
            </span>
          </div>
          <FilterChips value={place} onChange={onPlace} options={places} />
          <FilterChips
            value={template}
            onChange={onTemplate}
            options={[
              { value: "all" as const, label: "All templates" },
              ...SECRET_TEMPLATES.map((t) => ({ value: t, label: TEMPLATE_COPY[t].label })),
            ]}
          />
        </>
      }
    >
      {search.error ? (
        <Failed />
      ) : !search.data ? (
        <Loading />
      ) : hits.length === 0 && clients.length === 0 ? (
        <Empty
          title={`Nothing matches “${q}”`}
          note="Search reads titles, descriptions and open fields, never a password or a number."
        />
      ) : (
        <>
          {clients.length > 0 && (
            <div className="border-b border-divider">
              <p className="px-[18px] pt-3 text-[11px] font-semibold uppercase tracking-[.04em] text-muted-400">
                Clients
              </p>
              <table className="w-full border-collapse text-[13px]">
                <tbody>
                  {clients.map((client) => (
                    <tr
                      key={client.id}
                      className="cursor-pointer border-b border-divider last:border-0 hover:bg-[#f7f8fa]"
                      onClick={() =>
                        onGo({ type: "place", place: { kind: "client", clientId: client.id } })
                      }
                    >
                      <td className="px-[18px] py-2">
                        <div className="flex items-center gap-2.5">
                          <span className="grid h-[30px] w-[30px] flex-none place-items-center rounded-[7px] bg-divider text-muted">
                            <User size={15} />
                          </span>
                          <span className="font-medium text-ink">{client.label}</span>
                          <ClientCode code={client.code} />
                        </div>
                      </td>
                      <td className="w-40 px-3 py-2 text-[12.5px] tabular-nums text-muted">
                        {client.secrets} {client.secrets === 1 ? "secret" : "secrets"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {hits.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <tbody>
                  {hits.map((hit) => (
                    <tr
                      key={hit.id}
                      className="cursor-pointer border-b border-divider last:border-0 hover:bg-[#f7f8fa]"
                      onClick={() => onOpen(hit, placeOfHit(hit.crumbs))}
                    >
                      <td className="px-[18px] py-2">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <TemplateIcon template={hit.template} />
                          <div className="min-w-0">
                            <span className="font-medium text-ink [overflow-wrap:anywhere]">
                              {hit.label}
                            </span>
                            <span className="block text-[11.5px] text-muted-400">
                              {TEMPLATE_COPY[hit.template].label}
                              {summaryOf(hit) && ` · ${summaryOf(hit)}`}
                            </span>
                            {/* every step is a way there, and the last marks the secret (§10) */}
                            <span className="block text-[11.5px] text-muted-400">
                              {hit.crumbs.map((step, i) => (
                                <span key={i}>
                                  {i > 0 && " › "}
                                  <button
                                    type="button"
                                    className="hover:text-primary-link hover:underline"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      goTo(
                                        step,
                                        i === hit.crumbs.length - 1 ? hit.id : undefined,
                                      );
                                    }}
                                  >
                                    {step.label}
                                  </button>
                                </span>
                              ))}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="w-32 whitespace-nowrap px-3 py-2 text-[12.5px] text-ink-700">
                        {fmtDate(hit.updatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Pane>
  );
}

/** Each delete as one gesture, newest first, with what is left of its thirty days (§9). */
export function TrashPane() {
  const { data, error } = useTrash();
  const restoreBatch = useRestoreBatch();
  const restoreOne = useRestoreSecret();
  const batches = data?.batches ?? [];

  return (
    <Pane
      head={
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <span className="font-semibold text-ink">Trash</span>
          <span>· kept 30 days, then gone</span>
        </div>
      }
    >
      {error ? (
        <Failed />
      ) : !data ? (
        <Loading />
      ) : batches.length === 0 ? (
        <Empty title="The Trash is empty" />
      ) : (
        batches.map((batch) => (
          <div key={batch.batchId}>
            <div className="flex flex-wrap items-center gap-2 border-b border-divider bg-[#fafbfc] px-[18px] py-2.5 text-[12.5px] text-ink-700">
              <span>
                <b className="text-ink">{batch.deletedBy}</b> deleted {batch.items.length}{" "}
                {batch.items.length === 1 ? "secret" : "secrets"} ·{" "}
                {fmtDateTime(batch.deletedAt)}
              </span>
              <span className="flex-1" />
              <span
                className={cn(
                  "text-[12px] text-muted",
                  batch.daysLeft <= 5 && "font-semibold text-danger-text",
                )}
              >
                {batch.daysLeft} {batch.daysLeft === 1 ? "day" : "days"} left
              </span>
              {batch.items.length > 1 && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={restoreBatch.isPending}
                  onClick={() => void restoreBatch.mutateAsync(batch.batchId).catch(() => {})}
                >
                  <RotateCcw size={14} />
                  Restore all
                </Button>
              )}
            </div>
            <table className="w-full border-collapse text-[13px]">
              <tbody>
                {batch.items.map((item) => (
                  <tr key={item.id} className="border-b border-divider last:border-0">
                    <td className="px-[18px] py-2">
                      <div className="flex items-center gap-2.5">
                        <TemplateIcon template={item.template} />
                        <div>
                          <span className="font-medium text-ink">{item.label}</span>
                          <span className="block text-[11.5px] text-muted-400">
                            {item.place}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="w-32 px-3 py-2 text-right">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={restoreOne.isPending}
                        onClick={() => void restoreOne.mutateAsync(item.id).catch(() => {})}
                      >
                        <RotateCcw size={14} />
                        Restore
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </Pane>
  );
}

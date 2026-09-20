import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Building2, ChevronRight, Plus, Trash2, User, Users } from "lucide-react";
import type { SecretCard, SecretTemplate } from "@shared/schema/secrets";
import { api } from "@/shared/lib/api";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ClientCode } from "@/shared/ui/client-code";
import { SearchInput } from "@/shared/ui/search-input";
import { useSecretActions } from "./actions";
import { COMPANY, MY, samePlace, type UiPlace, type View } from "./places";
import { ClientsPane, PlacePane, SearchPane, TrashPane } from "./panes";
import { useClientNodes, useOverview } from "./secrets.api";
import { UnlockModal, VaultBar } from "./unlock";

/**
 * **The vault** (secrets.md §4, §15): three fixed places, the Trash, and one box over all of it.
 *
 * The places are drawn here rather than read from rows, which is what makes them impossible to
 * delete, rename or empty (§4.1). The Clients node is there only for somebody who may open clients
 * at all; My secrets is one list per person and nobody else's is reachable from here.
 */
function TreeNode({
  label,
  icon,
  count,
  active,
  depth = 0,
  caret,
  onCaret,
  onOpen,
}: {
  label: React.ReactNode;
  icon?: React.ReactNode;
  count?: number;
  active: boolean;
  depth?: number;
  caret?: boolean;
  onCaret?: () => void;
  onOpen: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-0.5 rounded-(--radius-btn-sm) hover:bg-[#f7f8fa]",
        active && "bg-primary-soft hover:bg-primary-soft",
      )}
      style={{ paddingLeft: depth * 14 }}
    >
      {onCaret ? (
        <button
          type="button"
          className="grid h-[26px] w-5 flex-none place-items-center rounded text-faint"
          aria-label="Show or hide clients"
          onClick={onCaret}
        >
          <ChevronRight
            size={13}
            className={cn("transition-transform", caret && "rotate-90")}
          />
        </button>
      ) : (
        <span className="h-[26px] w-5 flex-none" />
      )}
      <button
        type="button"
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 p-1 text-left text-[13px] text-ink-700",
          active && "font-semibold text-primary-link",
        )}
        onClick={onOpen}
      >
        {icon}
        <span className="truncate">{label}</span>
      </button>
      {count !== undefined && (
        <span className="pr-2 text-[11.5px] tabular-nums text-muted-400">{count}</span>
      )}
    </div>
  );
}

export function Vault() {
  const [view, setView] = useState<View>({ type: "place", place: COMPANY });
  /**
   * **`?secret=<id>` opens the place it lives in, with that entry marked** (chat.md §5.6). The
   * card route answers with the place and nothing secret, so a link is navigation: it takes a
   * colleague to the right list, and the entry is opened by them, on the screen, as always.
   */
  const [params, setParams] = useSearchParams();
  const linked = params.get("secret");
  const linkedSecret = useQuery({
    queryKey: ["secrets", "card", linked],
    queryFn: () => api<SecretCard>(`/api/secrets/${linked!}/card`),
    enabled: linked !== null,
    retry: false,
  });
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    if (!linked) return;
    const card = linkedSecret.data;
    if (card) {
      setRefused(false);
      setView({
        type: "place",
        place:
          card.place.space === "personal"
            ? MY
            : card.place.space === "company"
              ? COMPANY
              : { kind: "client", clientId: card.place.clientId },
        focus: card.id,
      });
    }
    if (linkedSecret.isError) setRefused(true);
    if (card || linkedSecret.isError) {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("secret");
          return next;
        },
        { replace: true },
      );
    }
  }, [linked, linkedSecret.data, linkedSecret.isError, setParams]);
  const [q, setQ] = useState("");
  const [template, setTemplate] = useState<SecretTemplate | "all">("all");
  const [searchPlace, setSearchPlace] = useState<"all" | "my" | "company" | "clients">("all");
  const [clientsShown, setClientsShown] = useState(true);
  const [asking, setAsking] = useState(false);

  const overview = useOverview();
  const clientsOpen = overview.data?.clientsOpen ?? false;
  const clients = useClientNodes(clientsOpen);
  const searching = q.trim().length > 0;

  const go = (next: View) => {
    setView(next);
    setQ("");
    setTemplate("all");
  };
  const clientLabel = (clientId: string) =>
    clients.data?.find((c) => c.id === clientId)?.label ?? "Client";
  const clientCode = (clientId: string) => clients.data?.find((c) => c.id === clientId)?.code;
  const actions = useSecretActions({
    clientsOpen,
    whereOf: (place) =>
      place.kind === "my"
        ? "My secrets"
        : place.kind === "company"
          ? "Company"
          : clientLabel(place.clientId),
  });

  const isPlace = (place: UiPlace) =>
    !searching && view.type === "place" && samePlace(view.place, place);
  // a new secret goes into the place that is open, and into Company from anywhere else
  const target: UiPlace = !searching && view.type === "place" ? view.place : COMPANY;

  let pane: React.ReactNode;
  if (searching) {
    pane = (
      <SearchPane
        q={q.trim()}
        place={searchPlace}
        template={template}
        onPlace={setSearchPlace}
        onTemplate={setTemplate}
        onGo={go}
        onOpen={(secret, place) => actions.open(place, secret)}
      />
    );
  } else if (view.type === "clients") {
    pane = (
      <ClientsPane
        onOpenClient={(clientId) => go({ type: "place", place: { kind: "client", clientId } })}
      />
    );
  } else if (view.type === "trash") {
    pane = <TrashPane />;
  } else {
    const place = view.place;
    const title =
      place.kind === "my" ? (
        <>
          <span className="font-semibold text-ink">My secrets</span>
          <span>· only you see these</span>
        </>
      ) : place.kind === "company" ? (
        <>
          <span className="font-semibold text-ink">Company</span>
          <span>· everyone with Secrets</span>
        </>
      ) : (
        <>
          <button
            type="button"
            className="hover:text-primary-link"
            onClick={() => go({ type: "clients" })}
          >
            Clients
          </button>
          <ChevronRight size={12} className="text-faint" />
          <span className="font-semibold text-ink">{clientLabel(place.clientId)}</span>
          {clientCode(place.clientId) !== undefined && (
            <ClientCode code={clientCode(place.clientId)!} />
          )}
        </>
      );
    pane = (
      <PlacePane
        key={place.kind === "client" ? place.clientId : place.kind}
        place={place}
        title={title}
        focus={view.focus}
        template={template}
        onTemplate={setTemplate}
        onOpen={(secret) => actions.open(place, secret)}
        canMove={actions.mayMoveFrom(place)}
        onMoveMany={(ids) => actions.move(place, ids)}
        onDeleteMany={(ids, done) => actions.remove(place, ids, done)}
      />
    );
  }

  return (
    <>
      {refused && (
        <button
          type="button"
          onClick={() => setRefused(false)}
          className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-(--radius-panel) border border-border bg-surface px-3 py-2 text-[12.5px] shadow-(--shadow-card)"
        >
          That entry is not open to you, or it is no longer there.
        </button>
      )}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold">Secrets</h1>
          <p className="mt-0.5 text-[13px] text-muted">
            The credentials the firm holds: yours, the firm's, and each client's.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search titles, sites, agencies, clients"
            aria-label="Search secrets"
            className="w-80"
          />
          <Button onClick={() => actions.create(target)}>
            <Plus size={15} />
            New secret
          </Button>
        </div>
      </div>

      <VaultBar onUnlock={() => setAsking(true)} />

      <div className="grid items-start gap-4 lg:grid-cols-[250px_minmax(0,1fr)]">
        <nav
          className="rounded-(--radius-panel) border border-border bg-surface p-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
          aria-label="Places"
        >
          <TreeNode
            label="My secrets"
            icon={<User size={15} className="text-muted" />}
            count={overview.data?.personal}
            active={isPlace(MY)}
            onOpen={() => go({ type: "place", place: MY })}
          />
          <TreeNode
            label="Company"
            icon={<Building2 size={15} className="text-muted" />}
            count={overview.data?.company}
            active={isPlace(COMPANY)}
            onOpen={() => go({ type: "place", place: COMPANY })}
          />
          {clientsOpen && (
            <>
              <TreeNode
                label="Clients"
                icon={<Users size={15} className="text-muted" />}
                count={overview.data?.clients}
                active={!searching && view.type === "clients"}
                caret={clientsShown}
                onCaret={() => setClientsShown((was) => !was)}
                onOpen={() => go({ type: "clients" })}
              />
              {clientsShown &&
                clients.data?.map((client) => (
                  <TreeNode
                    key={client.id}
                    depth={1}
                    label={
                      <>
                        {client.label}
                        <ClientCode code={client.code} className="ml-1.5" />
                      </>
                    }
                    count={client.secrets}
                    active={isPlace({ kind: "client", clientId: client.id })}
                    onOpen={() =>
                      go({ type: "place", place: { kind: "client", clientId: client.id } })
                    }
                  />
                ))}
            </>
          )}
          <div className="h-1.5" />
          <TreeNode
            label="Trash"
            icon={<Trash2 size={15} className="text-muted" />}
            count={overview.data?.trash}
            active={!searching && view.type === "trash"}
            onOpen={() => go({ type: "trash" })}
          />
        </nav>

        {pane}
      </div>

      {actions.dialogs}
      {asking && <UnlockModal onClose={() => setAsking(false)} />}
    </>
  );
}

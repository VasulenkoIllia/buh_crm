import { useState } from "react";
import { Plus } from "lucide-react";
import type { SecretTemplate } from "@shared/schema/secrets";
import { fmtDateTime } from "@/shared/lib/format";
import { Button } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";
import { Modal } from "@/shared/ui/modal";
import { useSecretActions } from "./actions";
import { ACTION } from "./entry";
import { PlacePane } from "./panes";
import type { UiPlace } from "./places";
import { useClientAudit } from "./secrets.api";
import { UnlockModal, VaultBar } from "./unlock";

/**
 * **The client card's Secrets tab** (secrets.md §15): the same list the Secrets screen shows for
 * this client, with the same templates, the same window, the same acts and the same unlock, which
 * covers the whole vault rather than this client. What it adds is the client's Access log.
 *
 * It is the module's, published lazily through the barrel, so the forms and the generator are
 * fetched when somebody opens the tab rather than with every card.
 */
export function ClientSecrets({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const place: UiPlace = { kind: "client", clientId };
  const [template, setTemplate] = useState<SecretTemplate | "all">("all");
  const [asking, setAsking] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  // a card is open only to somebody who can open clients, so a move may always name one
  const actions = useSecretActions({
    clientsOpen: true,
    whereOf: (p) =>
      p.kind === "client" ? clientName : p.kind === "company" ? "Company" : "My secrets",
  });

  return (
    <div className="space-y-3">
      <VaultBar onUnlock={() => setAsking(true)} />
      <PlacePane
        place={place}
        title={
          <>
            <span className="font-semibold text-ink">Secrets</span>
            <span className="flex-1" />
            <Button variant="text" size="sm" onClick={() => setLogOpen(true)}>
              Access log
            </Button>
            <Button variant="secondary" size="sm" onClick={() => actions.create(place)}>
              <Plus size={14} />
              New secret
            </Button>
          </>
        }
        template={template}
        onTemplate={setTemplate}
        onOpen={(secret) => actions.open(place, secret)}
        canMove={actions.mayMoveFrom(place)}
        onMoveMany={(ids) => actions.move(place, ids)}
        onDeleteMany={(ids, done) => actions.remove(place, ids, done)}
      />
      {actions.dialogs}
      {asking && <UnlockModal onClose={() => setAsking(false)} />}
      {logOpen && <AccessLog clientId={clientId} onClose={() => setLogOpen(false)} />}
    </div>
  );
}

/** Who did what to this client's secrets, a page at a time: the log only grows (§11). */
function AccessLog({ clientId, onClose }: { clientId: string; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const { data, error } = useClientAudit(clientId, page);
  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <Modal
      title="Access log"
      open
      onClose={onClose}
      footer={
        <>
          {data && data.total > data.pageSize && (
            <div className="mr-auto flex items-center gap-2 text-[12px] text-muted">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <span className="tabular-nums">
                Page {data.page} of {pageCount}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= pageCount}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          )}
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {error && <p className="text-[13px] text-danger-text">Failed to load.</p>}
      {!data && !error && <p className="text-[13px] text-muted">Loading…</p>}
      {data?.items.length === 0 && (
        <p className="text-[13px] text-muted">Nothing recorded yet.</p>
      )}
      <div className="text-[12.5px]">
        {data?.items.map((row) => {
          const act = ACTION[row.action] ?? { text: row.action, tone: "gray" as const };
          return (
            <div
              key={row.id}
              className="flex items-center gap-2 border-b border-divider py-1.5 last:border-0"
            >
              <Chip tone={act.tone} size="sm">
                {act.text}
              </Chip>
              <span className="min-w-0 truncate text-ink-700">
                {row.label ?? (row.action === "unlock_failed" ? "" : "(deleted)")}
              </span>
              <span className="ml-auto flex-none text-muted">
                {row.byName} · {fmtDateTime(row.createdAt)}
              </span>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

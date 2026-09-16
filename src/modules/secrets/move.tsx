import { useState } from "react";
import { Building2, User, Users } from "lucide-react";
import { ApiError } from "@/shared/lib/api";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Modal } from "@/shared/ui/modal";
import { SearchSelect } from "@/shared/ui/search-select";
import { useToast } from "@/shared/ui/toast";
import type { UiPlace } from "./places";
import { useMoveSecrets, type ClientNode } from "./secrets.api";

type Target = "my" | "company" | "client";

/**
 * **Moving secrets to another place** (secrets.md §7). A selection stays within one place, and the
 * move asks once with the count. The ciphertext does not move: the key is the same everywhere.
 *
 * Out of a CLIENT only an admin may move — the screen does not offer it to anyone else, and the
 * server's own route refuses it regardless. The one note shown is the one a person could get wrong:
 * moving out of My secrets into Company shares it with the firm.
 */
export function MoveDialog({
  from,
  ids,
  title,
  clients,
  onClose,
}: {
  from: UiPlace;
  ids: string[];
  /** the one secret's title, or nothing for several */
  title?: string;
  /** null when the reader cannot open clients, so a client is no choice at all */
  clients: ClientNode[] | null;
  onClose: () => void;
}) {
  const move = useMoveSecrets(from);
  const toast = useToast();
  const [target, setTarget] = useState<Target | null>(null);
  const [clientId, setClientId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const here = (t: Target) => from.kind === t && t !== "client";
  const choice = (t: Target, label: string, icon: React.ReactNode) => (
    <button
      type="button"
      disabled={here(t)}
      aria-pressed={target === t}
      className={cn(
        "flex w-full items-center gap-2 rounded-(--radius-btn) px-2.5 py-2 text-left text-[13px] text-ink-700 hover:bg-[#f7f8fa]",
        target === t && "bg-primary-soft font-semibold text-primary-link hover:bg-primary-soft",
        here(t) && "cursor-not-allowed text-faint hover:bg-transparent",
      )}
      onClick={() => setTarget(t)}
    >
      {icon}
      {label}
      {here(t) && <span className="ml-auto text-[11px] font-normal text-faint">here</span>}
    </button>
  );

  const ready = target === "client" ? !!clientId && clientId !== clientOf(from) : !!target;

  const submit = async () => {
    setError(null);
    const to =
      target === "my"
        ? { space: "personal" as const }
        : target === "company"
          ? { space: "company" as const }
          : { space: "client" as const, clientId };
    try {
      const done = await move.mutateAsync({ ids, to });
      toast({ text: `${done.moved === 1 ? "Moved" : `${done.moved} moved`} to ${done.to}` });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not move");
    }
  };

  return (
    <Modal
      title={title ? `Move ${title}` : `Move ${ids.length} secrets`}
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ready || move.isPending} onClick={() => void submit()}>
            {move.isPending ? "Moving…" : ids.length > 1 ? `Move ${ids.length}` : "Move"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="rounded-(--radius-card) border border-border p-1">
          {choice("my", "My secrets", <User size={15} className="text-muted" />)}
          {choice("company", "Company", <Building2 size={15} className="text-muted" />)}
          {clients && choice("client", "A client", <Users size={15} className="text-muted" />)}
        </div>
        {target === "client" && clients && (
          <SearchSelect
            value={clientId}
            ariaLabel="The client to move into"
            placeholder="Type a name or a code"
            emptyLabel="Choose a client"
            options={clients
              .filter((c) => c.id !== clientOf(from))
              .map((c) => ({
                value: c.id,
                label: c.label,
                hint: `C-${String(c.code).padStart(3, "0")}`,
              }))}
            onChange={setClientId}
          />
        )}
        {target === "company" && from.kind === "my" && (
          <p className="rounded-(--radius-card) bg-primary-soft px-3 py-2 text-[12.5px] text-[#243a9e]">
            Everyone with Secrets will see {ids.length === 1 ? "it" : "them"}.
          </p>
        )}
        {error && <p className="text-[12.5px] text-danger-text">{error}</p>}
      </div>
    </Modal>
  );
}

const clientOf = (place: UiPlace) => (place.kind === "client" ? place.clientId : undefined);

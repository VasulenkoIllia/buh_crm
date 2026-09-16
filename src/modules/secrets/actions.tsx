import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { SecretTemplate } from "@shared/schema/secrets";
import { useAuth } from "@/app/auth";
import { ApiError } from "@/shared/lib/api";
import { Button } from "@/shared/ui/button";
import { Modal } from "@/shared/ui/modal";
import { useToast } from "@/shared/ui/toast";
import { SecretWindow, type Openable } from "./entry";
import { SecretForm, TemplatePicker } from "./forms";
import { MoveDialog } from "./move";
import type { UiPlace } from "./places";
import {
  trashSecrets,
  useClientNodes,
  useInvalidateVault,
  useRestoreBatch,
} from "./secrets.api";

type Deleting = { place: UiPlace; ids: string[]; done: () => void };

/**
 * **What a person does to secrets, wherever the list is** (secrets.md §7, §9, §15): open one, add
 * one, edit, move and delete with its Undo. The Secrets screen and the client card's tab both take
 * it from here, so the same act cannot follow two rules depending on where it was started.
 *
 * `whereOf` names a place in the words of the screen using it. `clientsOpen` says whether a move
 * may go into a client at all; the list of clients is fetched only when a move asks for it.
 */
export function useSecretActions({
  whereOf,
  clientsOpen,
}: {
  whereOf: (place: UiPlace) => string;
  clientsOpen: boolean;
}) {
  const { user } = useAuth();
  const toast = useToast();
  const invalidate = useInvalidateVault();
  const restore = useRestoreBatch();

  const [opened, setOpened] = useState<{ place: UiPlace; secret: Openable } | null>(null);
  const [picking, setPicking] = useState<UiPlace | null>(null);
  const [editing, setEditing] = useState<{
    place: UiPlace;
    template: SecretTemplate;
    secret?: Openable;
  } | null>(null);
  const [moving, setMoving] = useState<{ from: UiPlace; ids: string[]; title?: string } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const [trashing, setTrashing] = useState(false);
  const clients = useClientNodes(clientsOpen && !!moving);

  // out of a client only an admin moves (§7); the server's own route refuses anybody else anyway
  const mayMoveFrom = (place: UiPlace) => place.kind !== "client" || user?.role === "admin";

  async function undo(batchId: string) {
    try {
      await restore.mutateAsync(batchId);
      toast({ text: "Undone. Everything is back where it was" });
    } catch (e) {
      toast({
        text: e instanceof ApiError ? e.message : "It could not be undone; it is in the Trash",
      });
    }
  }

  /** Into the Trash as ONE gesture, which one Undo takes back (§9). */
  async function runTrash({ place, ids, done }: Deleting) {
    setTrashing(true);
    try {
      const r = await trashSecrets(place, ids);
      invalidate();
      setDeleting(null);
      done();
      toast({
        text:
          r.deleted === 1 ? "Moved to the Trash" : `${r.deleted} secrets moved to the Trash`,
        action: { label: "Undo", run: () => undo(r.batchId) },
      });
    } catch (e) {
      toast({ text: e instanceof ApiError ? e.message : "The delete did not go through" });
    } finally {
      setTrashing(false);
    }
  }

  // one secret goes straight to the Trash, with its Undo; several are asked about first
  const remove = (place: UiPlace, ids: string[], done: () => void = () => {}) =>
    ids.length === 1 ? void runTrash({ place, ids, done }) : setDeleting({ place, ids, done });

  const dialogs = (
    <>
      {opened && (
        <SecretWindow
          place={opened.place}
          secret={opened.secret}
          onClose={() => setOpened(null)}
          footer={() => (
            <>
              <Button
                variant="secondary"
                className="mr-auto hover:text-danger"
                onClick={() => {
                  setOpened(null);
                  remove(opened.place, [opened.secret.id]);
                }}
              >
                <Trash2 size={14} />
                Delete
              </Button>
              {mayMoveFrom(opened.place) && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setOpened(null);
                    setMoving({
                      from: opened.place,
                      ids: [opened.secret.id],
                      title: opened.secret.label,
                    });
                  }}
                >
                  Move
                </Button>
              )}
              <Button
                onClick={() => {
                  setOpened(null);
                  setEditing({
                    place: opened.place,
                    template: opened.secret.template,
                    secret: opened.secret,
                  });
                }}
              >
                Edit
              </Button>
            </>
          )}
        />
      )}
      {picking && (
        <TemplatePicker
          where={whereOf(picking)}
          onClose={() => setPicking(null)}
          onPick={(template) => {
            setPicking(null);
            setEditing({ place: picking, template });
          }}
        />
      )}
      {editing && (
        <SecretForm
          place={editing.place}
          where={whereOf(editing.place)}
          template={editing.template}
          secret={editing.secret}
          onClose={() => setEditing(null)}
        />
      )}
      {moving && (
        <MoveDialog
          from={moving.from}
          ids={moving.ids}
          title={moving.title}
          clients={clientsOpen ? (clients.data ?? []) : null}
          onClose={() => setMoving(null)}
        />
      )}
      {deleting && (
        <Modal
          title={`Delete ${deleting.ids.length} secrets?`}
          open
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={trashing}
                onClick={() => void runTrash(deleting)}
              >
                {trashing ? "Deleting…" : `Delete ${deleting.ids.length}`}
              </Button>
            </>
          }
        >
          <p className="text-[13px] text-ink-700">
            They wait in the Trash for 30 days, and one Undo brings them all back.
          </p>
        </Modal>
      )}
    </>
  );

  return {
    open: (place: UiPlace, secret: Openable) => setOpened({ place, secret }),
    create: (place: UiPlace) => setPicking(place),
    move: (from: UiPlace, ids: string[]) => setMoving({ from, ids }),
    remove,
    mayMoveFrom,
    /** every window the acts open; render it once, anywhere in the screen */
    dialogs,
  };
}

import { useState } from "react";
import type { Client } from "@shared/schema/client";
import { ApiError } from "@/shared/lib/api";
import { Button } from "@/shared/ui/button";
import { Modal } from "@/shared/ui/modal";
import { useUpdateClient } from "./clients.api";
import { PeopleEditor, peopleToRows, rowsToPeopleInput, type PersonRow } from "./people-editor";

/** Dedicated add/edit/remove for a client's People — writes only the `people` list. */
export function ClientPeopleModal({
  open,
  onClose,
  client,
}: {
  open: boolean;
  onClose: () => void;
  client: Client;
}) {
  const update = useUpdateClient();
  const [rows, setRows] = useState<PersonRow[]>(() => peopleToRows(client.people));

  const close = () => {
    setRows(peopleToRows(client.people));
    update.reset();
    onClose();
  };

  const save = async () => {
    try {
      await update.mutateAsync({ id: client.id, input: { people: rowsToPeopleInput(rows) } });
      onClose();
    } catch {
      /* surfaced via serverError below */
    }
  };

  const serverError = update.error instanceof ApiError ? update.error.message : null;

  return (
    <Modal
      title="Manage people"
      open={open}
      onClose={close}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[12px] text-muted">
          Contacts for this client and the service each of them handles. Add, edit, or remove
          people, then Save.
        </p>
        <PeopleEditor value={rows} onChange={setRows} />
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
      </div>
    </Modal>
  );
}

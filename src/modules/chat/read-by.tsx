import { UserAvatar } from "@/shared/ui/avatar";
import { Modal } from "@/shared/ui/modal";
import { fmtDateTime } from "@/shared/lib/format";
import { useReadBy } from "./chat.api";

/**
 * **Who has read a message** (chat.md §5.4), with when their marker last moved. Any member may
 * open it: a read marker is not a secret from the people in the chat.
 */
export function ReadBy({ messageId, onClose }: { messageId: string; onClose: () => void }) {
  const { data, isLoading } = useReadBy(messageId);
  return (
    <Modal open onClose={onClose} title="Read by">
      {isLoading && <p className="text-[12.5px] text-muted">Loading…</p>}
      {data?.people.length === 0 && (
        <p className="text-[12.5px] text-muted">Nobody has read it yet.</p>
      )}
      {data?.people.map((person) => (
        <div key={person.id} className="flex items-center gap-2 py-1.5">
          <UserAvatar user={person} size="sm" />
          <span className="text-[13px]">
            {person.firstName} {person.lastName}
          </span>
          <span className="ml-auto text-[11.5px] text-muted">
            {person.at ? fmtDateTime(person.at) : ""}
          </span>
        </div>
      ))}
    </Modal>
  );
}

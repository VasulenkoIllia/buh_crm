import { Component, Suspense, type ReactNode } from "react";
import type { CreateInvoiceItemInput, InvoiceItem } from "@shared/schema/invoice-items";
import { InvoiceItemForm } from "@/modules/settings";
import { Modal } from "@/shared/ui/modal";
import { useAddInvoiceItem } from "./payments.api";

/**
 * **A new invoice item from a row** (payments.md §3, owner 2026-11-05: "the way a new client is
 * added"): Settings' own form, over New invoice or the correction, with the name the Position box
 * did not find and the row's unit and rate in it, to be checked before saving. Through Billing's
 * route, so whoever bills may. It used to save at once from the list, with whatever the row held,
 * which was nothing yet when the name was typed first.
 *
 * It does not close while the item is being saved: the row is linked when the answer comes, and a
 * form closed before it would leave the item made and the row not knowing it.
 */
export function NewItemModal({
  initial,
  onAdded,
  onClose,
}: {
  initial: CreateInvoiceItemInput;
  onAdded: (item: InvoiceItem) => void;
  onClose: () => void;
}) {
  const add = useAddInvoiceItem();
  const close = () => {
    if (!add.isPending) onClose();
  };
  return (
    <Modal title="New invoice item" open onClose={close}>
      <FormLoadFailed>
        <Suspense fallback={<p className="text-[13px] text-muted">Loading…</p>}>
          <InvoiceItemForm
            initial={initial}
            framed={false}
            isPending={add.isPending}
            error={add.error?.message ?? null}
            onCancel={close}
            onSave={(input) =>
              add.mutate(input, {
                onSuccess: ({ item }) => {
                  if (item) onAdded(item);
                  onClose();
                },
              })
            }
          />
        </Suspense>
      </FormLoadFailed>
    </Modal>
  );
}

/**
 * The form is a chunk of its own, and a tab left open across a deploy asks for one the server no
 * longer has. Caught here, so the invoice being written under this modal survives it.
 */
class FormLoadFailed extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? (
      <p role="alert" className="text-[13px] text-danger-text">
        The form did not load. Close it, finish the invoice, and add the item after reloading
        the page.
      </p>
    ) : (
      this.props.children
    );
  }
}

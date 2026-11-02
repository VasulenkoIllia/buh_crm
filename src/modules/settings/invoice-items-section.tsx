import { useState } from "react";
import {
  INVOICE_ITEM_PRICE_MAX,
  itemPriceLabel,
  type CreateInvoiceItemInput,
  type InvoiceItem,
  type UpdateInvoiceItemInput,
} from "@shared/schema/invoice-items";
import { useCanEdit } from "@/app/auth";
import { cn } from "@/shared/lib/cn";
import { fmtMoney, moneyInputValue, parseMoney } from "@/shared/lib/money";
import { Button, IconButton } from "@/shared/ui/button";
import { FormField, Input } from "@/shared/ui/field";
import { IconDelete, IconEdit, IconToggle } from "@/shared/ui/icons";
import { Segmented } from "@/shared/ui/segmented";
import {
  useCreateInvoiceItem,
  useDeleteInvoiceItem,
  useInvoiceItems,
  useUpdateInvoiceItem,
} from "./invoice-items.api";

/**
 * **Settings → Invoices → Invoice items** (payments.md §3): the positions New invoice and the
 * correction pick from, by name. Changed by whoever may change Settings. A line keeps its own copy,
 * so an edit here reaches the next invoices only, and an item some line came from is deactivated,
 * which takes it out of the picker, rather than deleted.
 */
export function InvoiceItemsSection() {
  const { data, isError, refetch } = useInvoiceItems();
  const canEdit = useCanEdit("settings");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const isFormOpen = editing === "new" || !!data?.some((item) => item.id === editing);

  // a failed refetch keeps the list it has, and an open form with it
  if (!data) {
    return isError ? (
      <div className="flex items-center gap-3">
        <p className="text-[13px] text-danger-text">The invoice items did not load.</p>
        <Button variant="secondary" size="sm" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    ) : (
      <p className="text-[13px] text-muted">Loading…</p>
    );
  }

  return (
    <div className="space-y-2">
      {data.length === 0 && editing !== "new" && (
        <p className="text-[13px] text-muted">No items yet, so positions are typed by hand.</p>
      )}
      {data.map((item) =>
        editing === item.id ? (
          <EditItem key={item.id} item={item} onDone={() => setEditing(null)} />
        ) : (
          <ItemRow
            key={item.id}
            item={item}
            canEdit={canEdit}
            onEdit={() => setEditing(item.id)}
          />
        ),
      )}

      {canEdit && editing === "new" && <AddItem onDone={() => setEditing(null)} />}
      {/* not while a form is open: pressing it would close that edit unsaved. A row a colleague
          deleted meanwhile has no form left, so it does not count */}
      {canEdit && !isFormOpen && (
        <Button variant="secondary" size="sm" onClick={() => setEditing("new")}>
          Add item
        </Button>
      )}
    </div>
  );
}

/** a finger's width on a phone; the 28px row action everywhere else */
const TAP = "max-sm:size-11";

function ItemRow({
  item,
  canEdit,
  onEdit,
}: {
  item: InvoiceItem;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const update = useUpdateInvoiceItem();
  const remove = useDeleteInvoiceItem();
  // on the row it is about, which on a phone is where the eye is
  const [error, setError] = useState<string | null>(null);

  const act = (run: () => Promise<unknown>) => {
    setError(null);
    run().catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not do that"));
  };

  return (
    <div className="rounded-(--radius-field) border border-border px-3 py-2">
      {/* on a phone the actions take a line of their own: three finger-wide buttons beside the
          name left it a word per line */}
      <div className="flex items-center justify-between gap-3 max-sm:flex-col max-sm:items-stretch max-sm:gap-1">
        <div className={cn("min-w-0", !item.active && "opacity-60")}>
          <div className="flex flex-wrap items-center gap-x-2">
            <span className="text-[14px] font-medium break-words">{item.name}</span>
            {!item.active && <span className="text-[12px] text-muted">inactive</span>}
          </div>
          <div className="text-[12px] text-muted">
            {itemPriceLabel(item)}
            {item.price === null && ", no set price"}
          </div>
        </div>
        {canEdit && (
          <div className="flex shrink-0 items-center gap-1 max-sm:-ml-2.5">
            <IconButton label={`Edit ${item.name}`} className={TAP} onClick={onEdit}>
              <IconEdit />
            </IconButton>
            <IconButton
              label={
                item.active
                  ? `Deactivate ${item.name}: it leaves the picker`
                  : `Activate ${item.name}`
              }
              disabled={update.isPending}
              className={cn(TAP, item.active && "text-primary-link hover:text-primary-link")}
              onClick={() =>
                act(() => update.mutateAsync({ id: item.id, input: { active: !item.active } }))
              }
            >
              <IconToggle />
            </IconButton>
            {/* offered on every item and refused by the server while a line came from it, as a
                source is: whether it is in use can change between drawing and pressing */}
            <IconButton
              label={`Delete ${item.name}`}
              className={TAP}
              danger
              disabled={remove.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    `Delete “${item.name}”? Possible only while no invoice uses it.`,
                  )
                ) {
                  act(() => remove.mutateAsync(item.id));
                }
              }}
            >
              <IconDelete />
            </IconButton>
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-1.5 text-[12px] text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}

function AddItem({ onDone }: { onDone: () => void }) {
  const create = useCreateInvoiceItem();
  return (
    <ItemForm
      initial={{ name: "", unit: "hour", price: null }}
      isPending={create.isPending}
      error={create.error?.message ?? null}
      onCancel={onDone}
      onSave={(input) => create.mutate(input, { onSuccess: onDone })}
    />
  );
}

/**
 * Sends only what was changed in THIS form, compared with what it opened with, so a colleague's
 * edit that arrives meanwhile is not sent back over.
 */
function EditItem({ item, onDone }: { item: InvoiceItem; onDone: () => void }) {
  const update = useUpdateInvoiceItem();
  const [opened] = useState(item);
  return (
    <ItemForm
      initial={opened}
      isPending={update.isPending}
      error={update.error?.message ?? null}
      onCancel={onDone}
      onSave={(input) => {
        const changed: UpdateInvoiceItemInput = {};
        if (input.name !== opened.name) changed.name = input.name;
        if (input.unit !== opened.unit) changed.unit = input.unit;
        if (input.price !== opened.price) changed.price = input.price;
        if (Object.keys(changed).length === 0) return onDone();
        update.mutate({ id: item.id, input: changed }, { onSuccess: onDone });
      }}
    />
  );
}

function ItemForm({
  initial,
  isPending,
  error,
  onSave,
  onCancel,
}: {
  initial: CreateInvoiceItemInput;
  isPending: boolean;
  error: string | null;
  onSave: (input: CreateInvoiceItemInput) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [unit, setUnit] = useState(initial.unit);
  const [price, setPrice] = useState(
    initial.price !== null ? moneyInputValue(initial.price) : "",
  );
  // empty is no set price; anything typed has to come to more than nothing
  const priceValue = price.trim() ? parseMoney(price) : null;
  const priceProblem =
    priceValue === null
      ? undefined
      : priceValue <= 0
        ? "A price is above zero, or left empty"
        : priceValue > INVOICE_ITEM_PRICE_MAX
          ? `At most ${fmtMoney(INVOICE_ITEM_PRICE_MAX)}`
          : undefined;
  const canSave = !!name.trim() && !priceProblem && !isPending;

  return (
    // a form, so Enter and a phone's Go key save it
    <form
      className="space-y-3 rounded-(--radius-field) border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) onSave({ name: name.trim(), unit, price: priceValue });
      }}
    >
      <FormField label="Name" htmlFor="invoice-item-name">
        <Input
          id="invoice-item-name"
          autoFocus
          placeholder="Consultation, W-2 form"
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </FormField>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Counted in">
          <Segmented
            value={unit}
            onChange={setUnit}
            options={[
              { value: "hour", label: "Hours" },
              { value: "item", label: "Items" },
            ]}
          />
        </FormField>
        <FormField
          label={unit === "hour" ? "Price per hour" : "Price per item"}
          htmlFor="invoice-item-price"
          error={priceProblem}
        >
          <Input
            id="invoice-item-price"
            inputMode="decimal"
            placeholder="Typed on each invoice"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </FormField>
      </div>
      {error && (
        <p role="alert" className="text-[12px] text-danger-text">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={!canSave}>
          Save
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

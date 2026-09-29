import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { isClientFacing } from "@shared/schema/catalog";
import type { Client, ClientPersonInput } from "@shared/schema/client";
import { useCatalog } from "@/modules/catalog";
import { Button, IconButton } from "@/shared/ui/button";
import { Input } from "@/shared/ui/field";
import { SearchSelect } from "@/shared/ui/search-select";

/** One editable contact row. `role` isn't edited in the UI (kept null server-side). */
export type PersonRow = {
  name: string;
  serviceId: string;
  /** legacy pre-S3 free-text label — display-only, cleared once a service is picked */
  serviceLabel: string;
  phone: string;
  email: string;
};

/** client DTO people → editable rows */
export function peopleToRows(people: Client["people"]): PersonRow[] {
  return people.map((p) => ({
    name: p.name,
    serviceId: p.serviceId ?? "",
    serviceLabel: p.serviceLabel ?? "",
    phone: p.phone ?? "",
    email: p.email ?? "",
  }));
}

/** editable rows → API input (drop rows without a name; empty strings → null) */
export function rowsToPeopleInput(rows: PersonRow[]): ClientPersonInput[] {
  return rows
    .filter((p) => p.name.trim())
    .map((p) => ({
      name: p.name,
      serviceId: p.serviceId || null,
      // once a real service is picked the legacy text is retired
      serviceLabel: p.serviceId ? null : p.serviceLabel || null,
      phone: p.phone || null,
      email: p.email || null,
    }));
}

export function PeopleEditor({
  value,
  onChange,
  inline = false,
}: {
  value: PersonRow[];
  onChange: (rows: PersonRow[]) => void;
  /**
   * One row per person (name, service, phone, email) where the form is wide enough for it: half
   * the height of the two-row card, so a new client's first people fit a 13-inch MacBook without
   * their list scrolling (owner, 2026-09-29). The narrow Manage people dialog keeps the card.
   */
  inline?: boolean;
}) {
  const { data: services } = useCatalog();
  const set = (i: number, patch: Partial<PersonRow>) =>
    onChange(value.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  /**
   * The cards scroll in place when the form around them is short of height (the New client modal
   * is `fit`, 2026-09-29), and "+ Add person" stays under them in view. A person just added is at
   * the bottom of the list, so whatever scrolls (this list, or the Manage people dialog's body)
   * follows them there rather than leaving the new card below the fold.
   */
  const list = useRef<HTMLDivElement>(null);
  const count = useRef(value.length);
  useEffect(() => {
    if (value.length > count.current) {
      list.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
    }
    count.current = value.length;
  }, [value.length]);

  return (
    <div className="flex min-h-0 flex-col gap-2">
      {value.length > 0 && (
        // `min-h-[56px]`: one row always shows, however short the window, so "+ Add person"
        // never seems to do nothing
        <div ref={list} className="min-h-[56px] space-y-2 overflow-y-auto">
          {value.map((row, i) => {
            const name = (
              <Input
                className="flex-1"
                placeholder="Name"
                value={row.name}
                onChange={(e) => set(i, { name: e.target.value })}
              />
            );
            const service = (
              <div className="min-w-0 flex-1">
                <SearchSelect
                  ariaLabel="Service they handle"
                  value={row.serviceId}
                  onChange={(v) => set(i, { serviceId: v })}
                  placeholder={
                    row.serviceLabel ? `${row.serviceLabel} (legacy)` : "Service they handle…"
                  }
                  emptyLabel={row.serviceLabel ? `${row.serviceLabel} (legacy)` : "—"}
                  options={(services ?? [])
                    .filter((s) => isClientFacing(s) && (s.active || s.id === row.serviceId))
                    .map((s) => ({
                      value: s.id,
                      label: s.name,
                      hint: s.active ? undefined : "(inactive)",
                    }))}
                />
              </div>
            );
            const remove = (
              <IconButton
                label="Remove person"
                className="hover:text-danger"
                onClick={() => onChange(value.filter((_, idx) => idx !== i))}
              >
                <X size={16} />
              </IconButton>
            );
            const phone = (
              <Input
                className="flex-1"
                placeholder="Phone"
                value={row.phone}
                onChange={(e) => set(i, { phone: e.target.value })}
              />
            );
            const email = (
              <Input
                className="flex-1"
                placeholder="Email"
                value={row.email}
                onChange={(e) => set(i, { email: e.target.value })}
              />
            );
            return inline ? (
              <div
                key={i}
                // wraps rather than squeezes on a narrow window: each field keeps 140px
                className="flex flex-wrap items-center gap-2 rounded-(--radius-field) border border-border bg-surface p-2 [&>*:not(button)]:min-w-[140px]"
              >
                {name}
                {service}
                {phone}
                {email}
                {remove}
              </div>
            ) : (
              <div
                key={i}
                className="rounded-(--radius-field) border border-border bg-surface p-2"
              >
                <div className="flex gap-2">
                  {name}
                  {service}
                  {remove}
                </div>
                <div className="mt-2 flex gap-2">
                  {phone}
                  {email}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <Button
        type="button"
        variant="text"
        size="sm"
        className="self-start"
        onClick={() =>
          onChange([
            ...value,
            { name: "", serviceId: "", serviceLabel: "", phone: "", email: "" },
          ])
        }
      >
        + Add person
      </Button>
    </div>
  );
}

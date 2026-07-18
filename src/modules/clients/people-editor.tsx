import { X } from "lucide-react";
import type { Client, ClientPersonInput } from "@shared/schema/client";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/field";

/** One editable contact row. `role` isn't edited in the UI (kept null server-side). */
export type PersonRow = { name: string; serviceLabel: string; phone: string; email: string };

/** client DTO people → editable rows */
export function peopleToRows(people: Client["people"]): PersonRow[] {
  return people.map((p) => ({
    name: p.name,
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
      serviceLabel: p.serviceLabel || null,
      phone: p.phone || null,
      email: p.email || null,
    }));
}

export function PeopleEditor({
  value,
  onChange,
}: {
  value: PersonRow[];
  onChange: (rows: PersonRow[]) => void;
}) {
  const set = (i: number, patch: Partial<PersonRow>) =>
    onChange(value.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-2">
      {value.map((row, i) => (
        <div key={i} className="rounded-(--radius-field) border border-border bg-surface p-2">
          <div className="flex gap-2">
            <Input
              className="flex-1"
              placeholder="Name"
              value={row.name}
              onChange={(e) => set(i, { name: e.target.value })}
            />
            <Input
              className="flex-1"
              placeholder="Service they handle"
              value={row.serviceLabel}
              onChange={(e) => set(i, { serviceLabel: e.target.value })}
            />
            <button
              type="button"
              aria-label="Remove person"
              className="px-1 text-muted hover:text-danger"
              onClick={() => onChange(value.filter((_, idx) => idx !== i))}
            >
              <X size={16} />
            </button>
          </div>
          <div className="mt-2 flex gap-2">
            <Input
              className="flex-1"
              placeholder="Phone"
              value={row.phone}
              onChange={(e) => set(i, { phone: e.target.value })}
            />
            <Input
              className="flex-1"
              placeholder="Email"
              value={row.email}
              onChange={(e) => set(i, { email: e.target.value })}
            />
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="text"
        size="sm"
        onClick={() => onChange([...value, { name: "", serviceLabel: "", phone: "", email: "" }])}
      >
        + Add person
      </Button>
    </div>
  );
}

import { useState } from "react";
import { Building2, Search } from "lucide-react";
import type { MailoutTarget } from "@shared/schema/mailouts";
import { useClients } from "@/modules/clients";
import { useCatalog } from "@/modules/catalog";
import { cn } from "@/shared/lib/cn";
import { Input, Select } from "@/shared/ui/field";

/** The list is long; ask the server rather than filtering a page of 25 in the browser. */
const PICKER_PAGE_SIZE = 100;

/**
 * One addressee, flattened to a string so a picker can hold them all in one Set.
 *
 * A client and each of that client's companies are separate addressees with separate inboxes, and
 * the picker has to hold "Olena, and Kvitka Trade, but not Sonyachny FOP". Encoding the pair rather
 * than keeping two structures means selection, counting and the payload all read off one thing.
 */
const keyOf = (clientId: string, companyId: string | null) =>
  companyId ? `${clientId}:${companyId}` : clientId;

export function toTarget(key: string): MailoutTarget {
  const [clientId, companyId] = key.split(":");
  return companyId ? { clientId, companyId } : { clientId };
}

/** A saved campaign's stored list, back into picker keys. */
export const targetsToKeys = (targets: { clientId: string; companyId: string | null }[]) =>
  targets.map((t) => keyOf(t.clientId, t.companyId));

export interface PresetTarget {
  /** null = the client's own address */
  companyId: string | null;
  name: string;
  email: string | null;
}

/**
 * Who a letter goes to — shared by the one-off composer and the campaign editor.
 *
 * One component because it was two: both had their own `keyOf`, their own near-identical row, and
 * their own copy of "search, list, nest the companies". A third copy was about to be written for
 * scheduling from a client card, which is the point at which duplication stops being cheaper than
 * a component.
 *
 * The selection lives in the PARENT — both callers need it for their payload and for deciding
 * whether the form is ready, and a picker that owned it would have to report every change anyway.
 */
export function RecipientPicker({
  value,
  onChange,
  enabled,
  presetClientId,
  presetTargets,
  showBulkSelect = true,
}: {
  value: Set<string>;
  onChange: (next: Set<string>) => void;
  /** the clients query only runs while the modal is open */
  enabled: boolean;
  /** opened from a client's card — that client's inboxes are pinned above the search */
  presetClientId?: string;
  presetTargets?: PresetTarget[];
  /** a campaign picks a list by hand; a bulk send offers "select these N" */
  showBulkSelect?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [serviceId, setServiceId] = useState("");
  const services = useCatalog();

  const clients = useClients(
    {
      tab: "all",
      search: search || undefined,
      serviceId: serviceId || undefined,
      pageSize: PICKER_PAGE_SIZE,
    },
    { enabled },
  );

  const visible = clients.data?.items ?? [];
  const allVisibleSelected = visible.length > 0 && visible.every((c) => value.has(c.id));

  function toggle(key: string) {
    const next = new Set(value);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  }

  return (
    <div className="space-y-2">
      <p className="text-[12px] font-medium uppercase tracking-wide text-muted">To whom</p>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search clients…"
            className="pl-8"
          />
        </div>
        <Select
          value={serviceId}
          onChange={(e) => setServiceId(e.target.value)}
          className="w-[140px]"
        >
          <option value="">All services</option>
          {(services.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>

      {showBulkSelect && (
        // deliberately the clients' OWN addresses only — a bulk button that silently also wrote
        // to every company would be a much bigger act than the label admits
        <button
          type="button"
          onClick={() => {
            const next = new Set(value);
            for (const c of visible) {
              if (allVisibleSelected) next.delete(c.id);
              else next.add(c.id);
            }
            onChange(next);
          }}
          className="text-[12px] text-primary-link hover:underline"
          disabled={visible.length === 0}
        >
          {allVisibleSelected ? "Clear these" : `Select these ${visible.length}`}
        </button>
      )}

      {/* Opened from a client's card: their inboxes sit above the search rather than being hunted
          for. Without this, reaching one of their companies would mean finding the client again in
          a list the search pages at 100 — so it would work for a firm with ninety clients and stop
          working at a hundred and one. */}
      {presetClientId && presetTargets && presetTargets.length > 0 && (
        <div className="rounded-(--radius-field) border border-border">
          <p className="border-b border-divider px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
            {presetTargets[0].name}
          </p>
          {presetTargets.map((t) => (
            <Addressee
              key={t.companyId ?? "own"}
              name={t.companyId ? t.name : "Their own address"}
              email={t.email}
              nested={!!t.companyId}
              checked={value.has(keyOf(presetClientId, t.companyId))}
              onToggle={() => toggle(keyOf(presetClientId, t.companyId))}
            />
          ))}
        </div>
      )}

      <div className="max-h-[330px] overflow-y-auto rounded-(--radius-field) border border-border">
        {clients.isLoading ? (
          <p className="p-3 text-[13px] text-muted">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="p-3 text-[13px] text-faint">No clients match.</p>
        ) : (
          visible.map((c) => (
            <div key={c.id} className="border-b border-divider last:border-0">
              <Addressee
                name={c.displayName}
                email={c.email}
                checked={value.has(c.id)}
                onToggle={() => toggle(c.id)}
              />
              {/* the client's companies, each its own inbox — indented, because they belong to the
                  client above and are not clients in their own right */}
              {c.companies.map((co) => (
                <Addressee
                  key={co.id}
                  name={co.name}
                  email={co.email}
                  nested
                  checked={value.has(keyOf(c.id, co.id))}
                  onToggle={() => toggle(keyOf(c.id, co.id))}
                />
              ))}
            </div>
          ))
        )}
      </div>

      {clients.data && clients.data.total > visible.length && (
        <p className="text-[12px] text-muted">
          Showing {visible.length} of {clients.data.total} — narrow the search to reach the rest.
        </p>
      )}
    </div>
  );
}

/**
 * One line in the picker: a client, or — indented — one of their companies.
 *
 * The same row for both on purpose. A company is a real addressee with its own inbox, not a
 * property of the client, and the moment it is drawn as a lesser thing somebody starts wondering
 * whether ticking it really sends anything.
 */
function Addressee({
  name,
  email,
  checked,
  onToggle,
  nested = false,
}: {
  name: string;
  email: string | null;
  checked: boolean;
  onToggle: () => void;
  nested?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-divider/50",
        nested && "border-l-2 border-divider pl-6",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="size-3.5 accent-[var(--color-primary)]"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-ink">
          {nested && <Building2 size={11} className="mr-1 inline text-faint" />}
          {name}
        </span>
        <span className="block truncate text-[12px] text-muted">{email ?? "no email address"}</span>
      </span>
    </label>
  );
}

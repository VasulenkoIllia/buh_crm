import { useState } from "react";
import type { Client } from "@shared/schema/client";
import type { BillingPeriod } from "@shared/schema/enums";
import { ServiceChip, useCatalog } from "@/modules/catalog";
import { ApiError } from "@/shared/lib/api";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input, Label, Select } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { useAddSubscription, useSetCategories, useUpdateSubscription } from "./clients.api";

const PERIOD_LABEL: Record<BillingPeriod, string> = {
  month: "monthly",
  quarter: "quarterly",
  year: "yearly",
};

/** Subscription table inside the client card's Regular section. */
export function SubscriptionList({ client }: { client: Client }) {
  const { data: services } = useCatalog();
  const update = useUpdateSubscription();
  const byId = new Map((services ?? []).map((s) => [s.id, s]));

  if (client.subscriptions.length === 0) {
    return (
      <p className="text-[13px] text-muted">
        No subscriptions yet — add a service from the catalog below.
      </p>
    );
  }

  const serverError = update.error instanceof ApiError ? update.error.message : null;

  return (
    <div>
      {client.subscriptions.map((sub) => {
        const service = byId.get(sub.serviceId);
        const company = sub.companyId
          ? client.companies.find((c) => c.id === sub.companyId)?.name
          : null;
        return (
          <div
            key={sub.id}
            className={cn(
              "flex items-center gap-3 border-b border-divider py-2 text-[13px] last:border-0",
              !sub.active && "opacity-50",
            )}
          >
            {service ? (
              <ServiceChip name={service.name} color={service.color} />
            ) : (
              <span className="text-muted">unknown service</span>
            )}
            {company && <span className="text-[12px] text-muted">({company})</span>}
            <span className="ml-auto tabular-nums">${(sub.amount / 100).toFixed(2)}</span>
            <span className="w-16 text-[12px] text-muted">{PERIOD_LABEL[sub.period]}</span>
            <Button
              variant="secondary"
              size="sm"
              disabled={update.isPending}
              onClick={() =>
                update
                  .mutateAsync({
                    clientId: client.id,
                    subscriptionId: sub.id,
                    input: { active: !sub.active },
                  })
                  .catch(() => {})
              }
            >
              {sub.active ? "Stop" : "Resume"}
            </Button>
          </div>
        );
      })}
      {serverError && <p className="mt-1 text-[12px] text-danger-text">{serverError}</p>}
    </div>
  );
}

/** "Add service to client" — catalog list + per-client price (design: width 500). */
export function AddServiceModal({
  client,
  open,
  onClose,
}: {
  client: Client;
  open: boolean;
  onClose: () => void;
}) {
  const { data: services } = useCatalog();
  const add = useAddSubscription();
  const [serviceId, setServiceId] = useState("");
  const [amount, setAmount] = useState<number | null>(null);
  const [period, setPeriod] = useState<BillingPeriod>("month");
  const [companyId, setCompanyId] = useState("");

  const active = (services ?? []).filter((s) => s.active);
  const selected = active.find((s) => s.id === serviceId);

  const pick = (id: string) => {
    setServiceId(id);
    const svc = active.find((s) => s.id === id);
    setAmount(svc?.defaultAmount ?? null); // expected price prefills, editable per client
  };

  const save = async () => {
    if (!serviceId || amount == null) return;
    try {
      await add.mutateAsync({
        clientId: client.id,
        input: { serviceId, amount, period, companyId: companyId || null },
      });
      onClose();
    } catch {
      /* surfaced via serverError below */
    }
  };

  const serverError = add.error instanceof ApiError ? add.error.message : null;

  return (
    <Modal
      title="Add service to client"
      open={open}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!serviceId || amount == null || add.isPending} onClick={() => void save()}>
            {add.isPending ? "Adding…" : "Add to client"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="max-h-56 overflow-y-auto rounded-(--radius-field) border border-border">
          {active.length === 0 && (
            <p className="px-3 py-4 text-[13px] text-muted">
              The catalog is empty — create services on the Services page first.
            </p>
          )}
          {active.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => pick(s.id)}
              className={cn(
                "flex w-full items-center gap-2 border-b border-divider px-3 py-2 text-left text-[13px] last:border-0 hover:bg-divider/40",
                serviceId === s.id && "bg-[#eef1fb]",
              )}
            >
              <ServiceChip name={s.name} color={s.color} />
              <span className="text-[12px] text-muted">
                {s.type === "subscription" ? "Subscription" : "One-time"}
              </span>
              <span className="ml-auto text-[12px] text-muted">
                {s.defaultAmount != null ? `$${(s.defaultAmount / 100).toFixed(0)} expected` : "—"}
              </span>
            </button>
          ))}
        </div>

        {selected && (
          <div className="rounded-(--radius-field) bg-[#f7f8fa] p-3">
            <Label>Price for this client</Label>
            <div className="flex items-center gap-2">
              <span className="text-[13px] text-muted">$</span>
              <Input
                className="w-28"
                type="number"
                min={0}
                value={amount != null ? amount / 100 : ""}
                onChange={(e) =>
                  setAmount(e.target.value ? Math.round(Number(e.target.value) * 100) : null)
                }
              />
              <Select
                className="w-32"
                value={period}
                onChange={(e) => setPeriod(e.target.value as BillingPeriod)}
              >
                <option value="month">per month</option>
                <option value="quarter">per quarter</option>
                <option value="year">per year</option>
              </Select>
              {client.companies.length > 0 && (
                <Select
                  className="flex-1"
                  value={companyId}
                  onChange={(e) => setCompanyId(e.target.value)}
                >
                  <option value="">Client (main)</option>
                  {client.companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            <p className="mt-1.5 text-[12px] text-faint">
              Prefilled from the catalog's expected price — adjust for this client.
            </p>
          </div>
        )}
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
      </div>
    </Modal>
  );
}

/** Category chip picker — full replace of the client's chip set. */
export function CategoriesModal({
  client,
  open,
  onClose,
}: {
  client: Client;
  open: boolean;
  onClose: () => void;
}) {
  const { data: services } = useCatalog();
  const setCategories = useSetCategories();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(client.categories));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async () => {
    try {
      await setCategories.mutateAsync({ clientId: client.id, serviceIds: [...selected] });
      onClose();
    } catch {
      /* surfaced via serverError below */
    }
  };

  const serverError =
    setCategories.error instanceof ApiError ? setCategories.error.message : null;

  return (
    <Modal
      title="Service categories"
      open={open}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={setCategories.isPending} onClick={() => void save()}>
            {setCategories.isPending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-1.5">
        {(services ?? [])
          .filter((s) => s.active || selected.has(s.id))
          .map((s) => (
            <label key={s.id} className="flex cursor-pointer items-center gap-2 py-0.5">
              <input
                type="checkbox"
                checked={selected.has(s.id)}
                onChange={() => toggle(s.id)}
              />
              <ServiceChip name={s.name} color={s.color} />
            </label>
          ))}
        {(services ?? []).length === 0 && (
          <p className="text-[13px] text-muted">The catalog is empty.</p>
        )}
      </div>
      {serverError && <p className="mt-2 text-[12px] text-danger-text">{serverError}</p>}
    </Modal>
  );
}

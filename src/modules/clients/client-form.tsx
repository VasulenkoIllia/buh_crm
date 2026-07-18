import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { X } from "lucide-react";
import type { Client, ClientPersonInput } from "@shared/schema/client";
import type { ClientType } from "@shared/schema/enums";
import { ApiError } from "@/shared/lib/api";
import { Button } from "@/shared/ui/button";
import { FormField, Input, Label, Select } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { Segmented } from "@/shared/ui/segmented";
import { useSettings } from "@/modules/settings";
import { useCreateClient, useUpdateClient } from "./clients.api";

const formSchema = z
  .object({
    type: z.enum(["individual", "company"]),
    firstName: z.string(),
    lastName: z.string(),
    companyName: z.string(),
    phone: z.string(),
    email: z.union([z.email("Invalid email"), z.literal("")]),
    address: z.string(),
    sourceId: z.string(),
    description: z.string(),
    regular: z.boolean(),
  })
  .refine((v) => (v.type === "individual" ? v.firstName.trim() && v.lastName.trim() : true), {
    path: ["firstName"],
    message: "First and last name are required",
  })
  .refine((v) => (v.type === "company" ? v.companyName.trim() : true), {
    path: ["companyName"],
    message: "Company name is required",
  });
type FormValues = z.infer<typeof formSchema>;

type PersonRow = ClientPersonInput & { serviceLabel: string; phone: string; email: string };

export function ClientFormModal({
  open,
  onClose,
  client,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  client?: Client;
  onSaved?: (client: Client) => void;
}) {
  const create = useCreateClient();
  const update = useUpdateClient();
  const { data: settings } = useSettings();
  const [companyNames, setCompanyNames] = useState<string[]>(
    client?.companies.map((c) => c.name) ?? [],
  );
  const [people, setPeople] = useState<PersonRow[]>(
    client?.people.map((p) => ({
      name: p.name,
      serviceLabel: p.serviceLabel ?? "",
      phone: p.phone ?? "",
      email: p.email ?? "",
    })) ?? [],
  );

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting, dirtyFields },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      type: client?.type ?? "individual",
      firstName: client?.firstName ?? "",
      lastName: client?.lastName ?? "",
      companyName: client?.companyName ?? "",
      phone: client?.phone ?? "",
      email: client?.email ?? "",
      address: client?.address ?? "",
      sourceId: client?.sourceId ?? "",
      description: client?.description ?? "",
      regular: client?.isRegular ?? false,
    },
  });

  const type = watch("type");
  const isCompany = type === "company";

  const close = () => {
    reset();
    create.reset();
    update.reset();
    onClose();
  };

  const onSubmit = handleSubmit(async (values) => {
    // regularOverride is a 3-state value (true / false / null=auto) but the toggle is
    // 2-state. On CREATE, seed it (one-time → null=auto so a later subscription can flip
    // it). On EDIT, only send an explicit override when the toggle was actually changed —
    // otherwise omit it so an existing override (incl. explicit `false`) is preserved.
    const regularOverride: boolean | null | undefined = !client
      ? values.regular
        ? true
        : null
      : dirtyFields.regular
        ? values.regular
        : undefined;

    const input = {
      type: values.type as ClientType,
      firstName: values.firstName || null,
      lastName: values.lastName || null,
      companyName: isCompany ? values.companyName || null : null,
      phone: values.phone || null,
      email: values.email || null,
      address: values.address || null,
      sourceId: values.sourceId || null,
      description: values.description || null,
      ...(regularOverride !== undefined ? { regularOverride } : {}),
      companyNames,
      people: people
        .filter((p) => p.name.trim())
        .map((p) => ({
          name: p.name,
          serviceLabel: p.serviceLabel || null,
          phone: p.phone || null,
          email: p.email || null,
        })),
    };
    const saved = client
      ? await update.mutateAsync({ id: client.id, input })
      : await create.mutateAsync(input);
    onSaved?.(saved);
    close();
  });

  const mutation = client ? update : create;
  const serverError = mutation.error instanceof ApiError ? mutation.error.message : null;

  return (
    <Modal
      title={client ? "Edit client" : "New client"}
      open={open}
      onClose={close}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="client-form" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : client ? "Save" : "Create client"}
          </Button>
        </>
      }
    >
      <form id="client-form" onSubmit={onSubmit} className="space-y-3" noValidate>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Client type</Label>
            <Segmented
              value={type}
              onChange={(v) => setValue("type", v as ClientType, { shouldDirty: true })}
              options={[
                { value: "company", label: "Company" },
                { value: "individual", label: "Individual" },
              ]}
            />
          </div>
          <div>
            <Label>Engagement model</Label>
            <Segmented
              value={watch("regular") ? "regular" : "one_time"}
              onChange={(v) => setValue("regular", v === "regular", { shouldDirty: true })}
              options={[
                { value: "one_time", label: "One-time" },
                { value: "regular", label: "Regular" },
              ]}
            />
          </div>
        </div>

        {isCompany && (
          <FormField label="Company name" htmlFor="c-company" error={errors.companyName?.message}>
            <Input
              id="c-company"
              placeholder="e.g. Romashka LLC"
              error={!!errors.companyName}
              {...register("companyName")}
            />
          </FormField>
        )}

        <div className="grid grid-cols-2 gap-3">
          <FormField
            label={isCompany ? "Contact — first name" : "First name"}
            htmlFor="c-first"
            error={errors.firstName?.message}
          >
            <Input id="c-first" error={!!errors.firstName} {...register("firstName")} />
          </FormField>
          <FormField label={isCompany ? "Contact — last name" : "Last name"} htmlFor="c-last">
            <Input id="c-last" {...register("lastName")} />
          </FormField>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Phone" htmlFor="c-phone">
            <Input id="c-phone" {...register("phone")} />
          </FormField>
          <FormField label="Email" htmlFor="c-email" error={errors.email?.message}>
            <Input id="c-email" type="email" error={!!errors.email} {...register("email")} />
          </FormField>
        </div>
        <FormField label="Address" htmlFor="c-address">
          <Input id="c-address" {...register("address")} />
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{isCompany ? "Related companies" : "Companies"}</Label>
            <TagInput
              value={companyNames}
              onChange={setCompanyNames}
              placeholder="Name + Enter…"
            />
          </div>
          <FormField label="Source" htmlFor="c-source">
            <Select id="c-source" {...register("sourceId")}>
              <option value="">—</option>
              {settings?.sources
                .filter((s) => s.active)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </Select>
          </FormField>
        </div>

        <div>
          <Label>People</Label>
          <PeopleEditor value={people} onChange={setPeople} />
        </div>

        <FormField label="Description" htmlFor="c-desc">
          <textarea
            id="c-desc"
            rows={2}
            className="w-full rounded-(--radius-field) border border-border bg-surface px-3 py-2 text-[14px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
            {...register("description")}
          />
        </FormField>
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
      </form>
    </Modal>
  );
}

/** Simple text tag input (per-client company names — no cross-client autocomplete). */
function TagInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (names: string[]) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState("");
  const add = (name: string) => {
    const t = name.trim();
    if (t && !value.some((v) => v.toLowerCase() === t.toLowerCase())) onChange([...value, t]);
    setInput("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-(--radius-field) border border-border bg-surface px-2 py-1.5 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30">
      {value.map((name) => (
        <span
          key={name}
          className="inline-flex items-center gap-1 rounded-(--radius-chip) bg-divider px-2 py-0.5 text-[12px] font-medium"
        >
          {name}
          <button
            type="button"
            aria-label={`Remove ${name}`}
            onClick={() => onChange(value.filter((v) => v !== name))}
            className="text-muted hover:text-ink"
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        className="min-w-32 flex-1 bg-transparent py-0.5 text-[14px] focus:outline-none"
        placeholder={value.length === 0 ? placeholder : ""}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(input);
          }
          if (e.key === "Backspace" && !input && value.length) onChange(value.slice(0, -1));
        }}
      />
    </div>
  );
}

function PeopleEditor({
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

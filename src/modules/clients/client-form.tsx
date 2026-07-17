import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { X } from "lucide-react";
import type { Client } from "@shared/schema/client";
import { ApiError } from "@/shared/lib/api";
import { Button } from "@/shared/ui/button";
import { FormField, Input, Label, Select } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { useSettings } from "@/modules/settings";
import { useCompanySearch, useCreateClient, useUpdateClient } from "./clients.api";

const formSchema = z.object({
  firstName: z.string().min(1, "Required"),
  lastName: z.string().min(1, "Required"),
  phone: z.string(),
  email: z.union([z.email("Invalid email"), z.literal("")]),
  address: z.string(),
  sourceId: z.string(),
  description: z.string(),
  regular: z.boolean(),
});
type FormValues = z.infer<typeof formSchema>;

export function ClientFormModal({
  open,
  onClose,
  client,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  client?: Client; // present = edit
  onSaved?: (client: Client) => void;
}) {
  const create = useCreateClient();
  const update = useUpdateClient();
  const [companyNames, setCompanyNames] = useState<string[]>(
    client?.companies.map((c) => c.name) ?? [],
  );
  const { data: settings } = useSettings();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      firstName: client?.firstName ?? "",
      lastName: client?.lastName ?? "",
      phone: client?.phone ?? "",
      email: client?.email ?? "",
      address: client?.address ?? "",
      sourceId: client?.sourceId ?? "",
      description: client?.description ?? "",
      regular: client?.isRegular ?? false,
    },
  });

  const close = () => {
    reset();
    create.reset();
    update.reset();
    onClose();
  };

  const onSubmit = handleSubmit(async (values) => {
    const input = {
      firstName: values.firstName,
      lastName: values.lastName,
      phone: values.phone || null,
      email: values.email || null,
      address: values.address || null,
      sourceId: values.sourceId || null,
      description: values.description || null,
      regularOverride: values.regular ? true : null,
      companyNames,
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
      <form id="client-form" onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="First name" htmlFor="c-first" error={errors.firstName?.message}>
            <Input id="c-first" error={!!errors.firstName} {...register("firstName")} />
          </FormField>
          <FormField label="Last name" htmlFor="c-last" error={errors.lastName?.message}>
            <Input id="c-last" error={!!errors.lastName} {...register("lastName")} />
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
        <div>
          <Label>Companies</Label>
          <CompanyTagInput value={companyNames} onChange={setCompanyNames} />
          <p className="mt-1 text-[12px] text-muted">
            A client may hold several companies — or none (private individual).
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
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
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" {...register("regular")} />
              Regular client
            </label>
          </div>
        </div>
        <FormField label="Description" htmlFor="c-desc">
          <textarea
            id="c-desc"
            rows={3}
            className="w-full rounded-(--radius-field) border border-border bg-surface px-3 py-2 text-[14px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
            {...register("description")}
          />
        </FormField>
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
      </form>
    </Modal>
  );
}

/** Tag input with autocomplete: pick an existing company or create by typing a new name. */
function CompanyTagInput({
  value,
  onChange,
}: {
  value: string[];
  onChange: (names: string[]) => void;
}) {
  const [input, setInput] = useState("");
  const { data: suggestions } = useCompanySearch(input);

  const add = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (!value.some((v) => v.toLowerCase() === trimmed.toLowerCase())) {
      onChange([...value, trimmed]);
    }
    setInput("");
  };

  const filtered = (suggestions ?? []).filter(
    (s) => !value.some((v) => v.toLowerCase() === s.name.toLowerCase()),
  );

  return (
    <div>
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
          className="min-w-28 flex-1 bg-transparent py-0.5 text-[14px] focus:outline-none"
          placeholder={value.length === 0 ? "Type a company name…" : ""}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(input);
            }
            if (e.key === "Backspace" && !input && value.length > 0) {
              onChange(value.slice(0, -1));
            }
          }}
        />
      </div>
      {input && (
        <div className="mt-1 rounded-(--radius-field) border border-border bg-surface shadow-(--shadow-card)">
          {filtered.slice(0, 5).map((s) => (
            <button
              key={s.id}
              type="button"
              className="block w-full px-3 py-1.5 text-left text-[13px] hover:bg-divider"
              onClick={() => add(s.name)}
            >
              {s.name}
            </button>
          ))}
          <button
            type="button"
            className="block w-full px-3 py-1.5 text-left text-[13px] text-primary-link hover:bg-divider"
            onClick={() => add(input)}
          >
            Create “{input.trim()}”
          </button>
        </div>
      )}
    </div>
  );
}

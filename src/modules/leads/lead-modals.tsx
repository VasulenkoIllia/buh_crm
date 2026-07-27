import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import { isClientFacing } from "@shared/schema/catalog";
import type { Lead } from "@shared/schema/lead";
import { ApiError } from "@/shared/lib/api";
import { Button } from "@/shared/ui/button";
import { FormField, Input, Select } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { SearchSelect } from "@/shared/ui/search-select";
import { useCatalog } from "@/modules/catalog";
import { useSettings } from "@/modules/settings";
import { useConvertLead, useCreateLead, useUpdateLead } from "./leads.api";

// only the name is required — a lead often arrives as a name and a note, with the phone or
// email filled in later (user, 2026-07-26; same rule server-side)
const leadFormSchema = z.object({
  name: z.string().min(1, "Required"),
  companyName: z.string(),
  phone: z.string(),
  email: z.union([z.email("Invalid email"), z.literal("")]),
  serviceId: z.string(),
  sourceId: z.string(),
  description: z.string(),
});
type LeadFormValues = z.infer<typeof leadFormSchema>;

export function LeadFormModal({
  open,
  onClose,
  lead,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  lead?: Lead;
  onSaved?: (lead: Lead) => void;
}) {
  const create = useCreateLead();
  const update = useUpdateLead();
  const { data: settings } = useSettings();
  const { data: services } = useCatalog();

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<LeadFormValues>({
    resolver: zodResolver(leadFormSchema),
    defaultValues: {
      name: lead?.name ?? "",
      companyName: lead?.companyName ?? "",
      phone: lead?.phone ?? "",
      email: lead?.email ?? "",
      serviceId: lead?.serviceId ?? "",
      sourceId: lead?.sourceId ?? "",
      description: lead?.description ?? "",
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
      name: values.name,
      companyName: values.companyName || null,
      phone: values.phone || null,
      email: values.email || null,
      serviceId: values.serviceId || null,
      sourceId: values.sourceId || null,
      description: values.description || null,
    };
    try {
      if (lead) {
        await update.mutateAsync({ id: lead.id, input });
      } else {
        const created = await create.mutateAsync(input);
        onSaved?.(created);
      }
      close();
    } catch {
      /* surfaced via serverError below */
    }
  });

  const mutation = lead ? update : create;
  const serverError = mutation.error instanceof ApiError ? mutation.error.message : null;

  return (
    <Modal
      title={lead ? "Edit lead" : "New lead"}
      open={open}
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="lead-form" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : lead ? "Save" : "Create lead"}
          </Button>
        </>
      }
    >
      <form id="lead-form" onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Name" htmlFor="l-name" error={errors.name?.message}>
            <Input
              id="l-name"
              // the name is the first thing you type — open the modal and start typing
              autoFocus
              placeholder="e.g. Petro Tkach"
              error={!!errors.name}
              {...register("name")}
            />
          </FormField>
          {/* informational, like the client's — carried over as-is on convert */}
          <FormField label="Company (optional)" htmlFor="l-company">
            <Input id="l-company" placeholder="e.g. Romashka LLC" {...register("companyName")} />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Phone" htmlFor="l-phone" error={errors.phone?.message}>
            <Input
              id="l-phone"
              placeholder="+380 67 123 4567"
              error={!!errors.phone}
              {...register("phone")}
            />
          </FormField>
          <FormField label="Email" htmlFor="l-email" error={errors.email?.message}>
            <Input
              id="l-email"
              type="email"
              placeholder="name@example.com"
              error={!!errors.email}
              {...register("email")}
            />
          </FormField>
        </div>
        <FormField label="Service they came for" htmlFor="l-service">
          {/* searchable: the catalog grows past what a plain dropdown is comfortable to scan */}
          <SearchSelect
            id="l-service"
            placeholder="Search services…"
            value={watch("serviceId")}
            onChange={(v) => setValue("serviceId", v, { shouldDirty: true })}
            options={(services ?? [])
              // an inactive service stays listed while it's the one already picked (history)
              .filter((s) => isClientFacing(s) && (s.active || s.id === lead?.serviceId))
              .map((s) => ({
                value: s.id,
                label: s.name,
                hint: s.active ? undefined : "(inactive)",
              }))}
          />
        </FormField>
        <FormField label="Source" htmlFor="l-source">
          <Select id="l-source" {...register("sourceId")}>
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
        <FormField label="Description" htmlFor="l-desc">
          <textarea
            id="l-desc"
            rows={2}
            placeholder="What they need, context, next step…"
            className="w-full rounded-(--radius-field) border border-border bg-surface px-3 py-2 text-[14px] placeholder:text-faint focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
            {...register("description")}
          />
        </FormField>
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
      </form>
    </Modal>
  );
}

// ── Convert dialog: the reviewed fields become the new client ────────────────

// Same shape as a hand-created client: the first name identifies it, the last name is optional
// (a one-word lead name splits to a first name only), and the company is a plain label.
const convertFormSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required"),
  lastName: z.string(),
  companyName: z.string(),
  phone: z.string(),
  email: z.union([z.email("Invalid email"), z.literal("")]),
  address: z.string(),
});
type ConvertFormValues = z.infer<typeof convertFormSchema>;

export function ConvertLeadModal({
  lead,
  open,
  onClose,
}: {
  lead: Lead;
  open: boolean;
  onClose: () => void;
}) {
  const convert = useConvertLead();
  const navigate = useNavigate();

  // seed: individual → split lead name into first/last; company → lead name = company name
  const [first, ...rest] = lead.name.trim().split(/\s+/);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ConvertFormValues>({
    resolver: zodResolver(convertFormSchema),
    defaultValues: {
      firstName: first ?? "",
      lastName: rest.join(" "),
      companyName: lead.companyName ?? "",
      phone: lead.phone ?? "",
      email: lead.email ?? "",
      address: "",
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const { clientId } = await convert.mutateAsync({
        id: lead.id,
        input: {
          firstName: values.firstName.trim(),
          lastName: values.lastName || null,
          companyName: values.companyName || null,
          phone: values.phone || null,
          email: values.email || null,
          address: values.address || null,
          sourceId: lead.sourceId,
          description: lead.description,
        },
      });
      onClose();
      navigate(`/clients/${clientId}`);
    } catch {
      /* surfaced via serverError below */
    }
  });

  const serverError = convert.error instanceof ApiError ? convert.error.message : null;

  return (
    <Modal
      title="Move to client"
      open={open}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="convert-form" variant="positive" disabled={isSubmitting}>
            {isSubmitting ? "Converting…" : "Create client"}
          </Button>
        </>
      }
    >
      <form id="convert-form" onSubmit={onSubmit} className="space-y-4" noValidate>
        <p className="text-[12px] text-muted">
          Review the details — the lead becomes a new client. The lead stays as read-only
          history marked <b>won</b>.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="First name" htmlFor="cv-first" error={errors.firstName?.message}>
            <Input
              id="cv-first"
              autoFocus
              placeholder="e.g. Ivan"
              error={!!errors.firstName}
              {...register("firstName")}
            />
          </FormField>
          <FormField label="Last name" htmlFor="cv-last">
            <Input id="cv-last" placeholder="e.g. Petrenko" {...register("lastName")} />
          </FormField>
        </div>
        <FormField label="Company (label)" htmlFor="cv-company">
          {/* informational — the client's real companies are added on their card afterwards */}
          <Input id="cv-company" placeholder="e.g. Romashka LLC" {...register("companyName")} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Phone" htmlFor="cv-phone">
            <Input id="cv-phone" placeholder="+380 67 123 4567" {...register("phone")} />
          </FormField>
          <FormField label="Email" htmlFor="cv-email" error={errors.email?.message}>
            <Input
              id="cv-email"
              type="email"
              placeholder="name@example.com"
              error={!!errors.email}
              {...register("email")}
            />
          </FormField>
        </div>
        <FormField label="Address" htmlFor="cv-address">
          <Input
            id="cv-address"
            placeholder="City, street, building, office"
            {...register("address")}
          />
        </FormField>
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
      </form>
    </Modal>
  );
}

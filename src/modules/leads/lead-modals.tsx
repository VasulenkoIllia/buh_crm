import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import type { ClientType } from "@shared/schema/enums";
import type { Lead } from "@shared/schema/lead";
import { ApiError } from "@/shared/lib/api";
import { Button } from "@/shared/ui/button";
import { FormField, Input, Label, Select } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { Segmented } from "@/shared/ui/segmented";
import { useCatalog } from "@/modules/catalog";
import { useSettings } from "@/modules/settings";
import { useConvertLead, useCreateLead, useUpdateLead } from "./leads.api";

const leadFormSchema = z
  .object({
    type: z.enum(["individual", "company"]),
    name: z.string().min(1, "Required"),
    phone: z.string(),
    email: z.union([z.email("Invalid email"), z.literal("")]),
    serviceId: z.string(),
    sourceId: z.string(),
    description: z.string(),
  })
  .refine((v) => v.phone.trim() || v.email, {
    path: ["phone"],
    message: "Phone or email is required",
  });
type LeadFormValues = z.infer<typeof leadFormSchema>;

export function LeadFormModal({
  open,
  onClose,
  lead,
}: {
  open: boolean;
  onClose: () => void;
  lead?: Lead;
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
      type: lead?.type ?? "individual",
      name: lead?.name ?? "",
      phone: lead?.phone ?? "",
      email: lead?.email ?? "",
      serviceId: lead?.serviceId ?? "",
      sourceId: lead?.sourceId ?? "",
      description: lead?.description ?? "",
    },
  });

  const type = watch("type");

  const close = () => {
    reset();
    create.reset();
    update.reset();
    onClose();
  };

  const onSubmit = handleSubmit(async (values) => {
    const input = {
      type: values.type as ClientType,
      name: values.name,
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
        await create.mutateAsync(input);
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
        <div>
          <Label>Lead type</Label>
          <Segmented
            value={type}
            onChange={(v) => setValue("type", v, { shouldDirty: true })}
            options={[
              { value: "company", label: "Company" },
              { value: "individual", label: "Individual" },
            ]}
          />
        </div>
        <FormField
          label={type === "company" ? "Company name" : "Name"}
          htmlFor="l-name"
          error={errors.name?.message}
        >
          <Input
            id="l-name"
            placeholder={type === "company" ? "e.g. Romashka LLC" : "e.g. Petro Tkach"}
            error={!!errors.name}
            {...register("name")}
          />
        </FormField>
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
          <Select id="l-service" {...register("serviceId")}>
            <option value="">—</option>
            {services
              ?.filter((s) => s.active || s.id === lead?.serviceId)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {!s.active ? " (inactive)" : ""}
                </option>
              ))}
          </Select>
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

// ── Convert dialog: type-aware reviewed fields → new client ──────────────────

const convertFormSchema = z
  .object({
    type: z.enum(["individual", "company"]),
    companyName: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    phone: z.string(),
    email: z.union([z.email("Invalid email"), z.literal("")]),
    address: z.string(),
  })
  .refine((v) => (v.type === "individual" ? v.firstName.trim() && v.lastName.trim() : true), {
    path: ["firstName"],
    message: "First and last name are required",
  })
  .refine((v) => (v.type === "company" ? v.companyName.trim() : true), {
    path: ["companyName"],
    message: "Company name is required",
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
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<ConvertFormValues>({
    resolver: zodResolver(convertFormSchema),
    defaultValues: {
      type: lead.type,
      companyName: lead.type === "company" ? lead.name : "",
      firstName: lead.type === "individual" ? (first ?? "") : "",
      lastName: lead.type === "individual" ? rest.join(" ") : "",
      phone: lead.phone ?? "",
      email: lead.email ?? "",
      address: "",
    },
  });

  const type = watch("type");
  const isCompany = type === "company";

  const onSubmit = handleSubmit(async (values) => {
    try {
      const { clientId } = await convert.mutateAsync({
        id: lead.id,
        input: {
          type: values.type as ClientType,
          firstName: values.firstName || null,
          lastName: values.lastName || null,
          companyName: isCompany ? values.companyName || null : null,
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
        <div>
          <Label>Client type</Label>
          <Segmented
            value={type}
            onChange={(v) => setValue("type", v, { shouldDirty: true })}
            options={[
              { value: "company", label: "Company" },
              { value: "individual", label: "Individual" },
            ]}
          />
        </div>
        {isCompany && (
          <FormField
            label="Company name"
            htmlFor="cv-company"
            error={errors.companyName?.message}
          >
            <Input
              id="cv-company"
              placeholder="e.g. Romashka LLC"
              error={!!errors.companyName}
              {...register("companyName")}
            />
          </FormField>
        )}
        <div className="grid grid-cols-2 gap-3">
          <FormField
            label={isCompany ? "Contact — first name" : "First name"}
            htmlFor="cv-first"
            error={errors.firstName?.message}
          >
            <Input
              id="cv-first"
              placeholder="e.g. Ivan"
              error={!!errors.firstName}
              {...register("firstName")}
            />
          </FormField>
          <FormField label={isCompany ? "Contact — last name" : "Last name"} htmlFor="cv-last">
            <Input id="cv-last" placeholder="e.g. Petrenko" {...register("lastName")} />
          </FormField>
        </div>
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

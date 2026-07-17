import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import type { Lead } from "@shared/schema/lead";
import { ApiError } from "@/shared/lib/api";
import { Button } from "@/shared/ui/button";
import { FormField, Input, Select } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { useSettings } from "@/modules/settings";
import { useConvertLead, useCreateLead, useUpdateLead } from "./leads.api";

const leadFormSchema = z
  .object({
    name: z.string().min(1, "Required"),
    phone: z.string(),
    email: z.union([z.email("Invalid email"), z.literal("")]),
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
  lead?: Lead; // present = edit
}) {
  const create = useCreateLead();
  const update = useUpdateLead();
  const { data: settings } = useSettings();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<LeadFormValues>({
    resolver: zodResolver(leadFormSchema),
    defaultValues: {
      name: lead?.name ?? "",
      phone: lead?.phone ?? "",
      email: lead?.email ?? "",
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
      phone: values.phone || null,
      email: values.email || null,
      sourceId: values.sourceId || null,
      description: values.description || null,
    };
    if (lead) {
      await update.mutateAsync({ id: lead.id, input });
    } else {
      await create.mutateAsync(input);
    }
    close();
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
        <FormField label="Name" htmlFor="l-name" error={errors.name?.message}>
          <Input id="l-name" error={!!errors.name} {...register("name")} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Phone" htmlFor="l-phone" error={errors.phone?.message}>
            <Input id="l-phone" error={!!errors.phone} {...register("phone")} />
          </FormField>
          <FormField label="Email" htmlFor="l-email" error={errors.email?.message}>
            <Input id="l-email" type="email" error={!!errors.email} {...register("email")} />
          </FormField>
        </div>
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

// ── Convert dialog: reviewed fields → new client ─────────────────────────────

const convertFormSchema = z.object({
  firstName: z.string().min(1, "Required"),
  lastName: z.string().min(1, "Required"),
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
      phone: lead.phone ?? "",
      email: lead.email ?? "",
      address: "",
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    const { clientId } = await convert.mutateAsync({
      id: lead.id,
      input: {
        firstName: values.firstName,
        lastName: values.lastName,
        phone: values.phone || null,
        email: values.email || null,
        address: values.address || null,
        sourceId: lead.sourceId,
        description: lead.description,
      },
    });
    onClose();
    navigate(`/clients/${clientId}`);
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
          Review the details — the lead's data becomes a new client. The lead stays as
          read-only history marked <b>won</b>.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="First name" htmlFor="cv-first" error={errors.firstName?.message}>
            <Input id="cv-first" error={!!errors.firstName} {...register("firstName")} />
          </FormField>
          <FormField label="Last name" htmlFor="cv-last" error={errors.lastName?.message}>
            <Input id="cv-last" error={!!errors.lastName} {...register("lastName")} />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Phone" htmlFor="cv-phone">
            <Input id="cv-phone" {...register("phone")} />
          </FormField>
          <FormField label="Email" htmlFor="cv-email" error={errors.email?.message}>
            <Input id="cv-email" type="email" error={!!errors.email} {...register("email")} />
          </FormField>
        </div>
        <FormField label="Address" htmlFor="cv-address">
          <Input id="cv-address" {...register("address")} />
        </FormField>
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
      </form>
    </Modal>
  );
}

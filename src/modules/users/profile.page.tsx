import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { password } from "@shared/schema/user";
import { useAuth } from "@/app/auth";
import { ApiError } from "@/shared/lib/api";
import { UserAvatar } from "@/shared/ui/avatar";
import { Button } from "@/shared/ui/button";
import { FormField, Input } from "@/shared/ui/field";
import { useUpdateProfile, useUploadAvatar } from "./users.api";

const nameSchema = z.object({
  firstName: z.string().min(1, "Required"),
  lastName: z.string().min(1, "Required"),
});
type NameValues = z.infer<typeof nameSchema>;

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, "Required"),
    newPassword: password,
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, {
    path: ["confirm"],
    message: "Passwords do not match",
  });
type PasswordValues = z.infer<typeof passwordSchema>;

export function ProfilePage() {
  const { user } = useAuth();
  if (!user) return null;

  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-[20px] font-semibold">Profile</h1>
      <AvatarSection />
      <NameSection defaults={{ firstName: user.firstName, lastName: user.lastName }} />
      <PasswordSection />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-(--radius-panel) border border-border bg-surface p-5 shadow-(--shadow-card)">
      <h2 className="mb-4 text-[15px] font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function AvatarSection() {
  const { user } = useAuth();
  const upload = useUploadAvatar();
  const inputRef = useRef<HTMLInputElement>(null);
  const [version, setVersion] = useState(0);

  if (!user) return null;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    await upload.mutateAsync(file);
    setVersion((v) => v + 1);
  };

  const serverError = upload.error instanceof ApiError ? upload.error.message : null;

  return (
    <Section title="Avatar">
      <div className="flex items-center gap-4">
        <UserAvatar user={user} size="lg" version={version} />
        <div>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          <Button
            variant="secondary"
            disabled={upload.isPending}
            onClick={() => inputRef.current?.click()}
          >
            {upload.isPending ? "Uploading…" : "Upload image"}
          </Button>
          <p className="mt-1.5 text-[12px] text-muted">PNG/JPG up to 5 MB.</p>
          {serverError && <p className="mt-1 text-[12px] text-danger-text">{serverError}</p>}
        </div>
      </div>
    </Section>
  );
}

function NameSection({ defaults }: { defaults: NameValues }) {
  const update = useUpdateProfile();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<NameValues>({ resolver: zodResolver(nameSchema), defaultValues: defaults });

  return (
    <Section title="Name">
      <form
        onSubmit={handleSubmit((v) => update.mutateAsync(v))}
        className="space-y-4"
        noValidate
      >
        <div className="grid grid-cols-2 gap-3">
          <FormField label="First name" htmlFor="p-first" error={errors.firstName?.message}>
            <Input
              id="p-first"
              placeholder="e.g. Ivan"
              error={!!errors.firstName}
              {...register("firstName")}
            />
          </FormField>
          <FormField label="Last name" htmlFor="p-last" error={errors.lastName?.message}>
            <Input
              id="p-last"
              placeholder="e.g. Petrenko"
              error={!!errors.lastName}
              {...register("lastName")}
            />
          </FormField>
        </div>
        <Button type="submit" disabled={isSubmitting || !isDirty}>
          {update.isSuccess && !isDirty ? "Saved" : "Save name"}
        </Button>
      </form>
    </Section>
  );
}

function PasswordSection() {
  const update = useUpdateProfile();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<PasswordValues>({ resolver: zodResolver(passwordSchema) });

  const onSubmit = handleSubmit(async (values) => {
    await update.mutateAsync({
      currentPassword: values.currentPassword,
      newPassword: values.newPassword,
    });
    reset();
  });

  const serverError = update.error instanceof ApiError ? update.error.message : null;

  return (
    <Section title="Change password">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormField
          label="Current password"
          htmlFor="p-current"
          error={errors.currentPassword?.message}
        >
          <Input
            id="p-current"
            type="password"
            autoComplete="current-password"
            placeholder="Your current password"
            error={!!errors.currentPassword}
            {...register("currentPassword")}
          />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="New password" htmlFor="p-new" error={errors.newPassword?.message}>
            <Input
              id="p-new"
              type="password"
              autoComplete="new-password"
              placeholder="At least 8 characters"
              error={!!errors.newPassword}
              {...register("newPassword")}
            />
          </FormField>
          <FormField label="Confirm" htmlFor="p-confirm" error={errors.confirm?.message}>
            <Input
              id="p-confirm"
              type="password"
              autoComplete="new-password"
              placeholder="Repeat the new password"
              error={!!errors.confirm}
              {...register("confirm")}
            />
          </FormField>
        </div>
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Change password"}
        </Button>
      </form>
    </Section>
  );
}

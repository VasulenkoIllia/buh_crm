import { Suspense, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { password } from "@shared/schema/user";
import { useAuth } from "@/app/auth";
import { ApiError } from "@/shared/lib/api";
import { UserAvatar } from "@/shared/ui/avatar";
import { Button } from "@/shared/ui/button";
import { FormField, Input } from "@/shared/ui/field";
import { Tabs } from "@/shared/ui/tabs";
import { NotificationPreferences } from "@/modules/notifications";
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

/**
 * Three tabs, in the shape the Settings and Mailouts screens use.
 *
 * Who you are · how you get in · what reaches you. The password form is its own tab rather than a
 * third card under the name: it is the one thing here somebody arrives wanting to do, and it
 * should not be found by scrolling past an avatar picker.
 */
const TABS = [
  { value: "account" as const, label: "Account" },
  { value: "password" as const, label: "Password" },
  { value: "notifications" as const, label: "Notifications" },
];
type Tab = (typeof TABS)[number]["value"];

/** One line each — a two-line one would move the tabs on that tab and no other. */
const BLURB: Record<Tab, string> = {
  account: "Your name and picture, as the rest of the team sees them.",
  password: "Set a new one. You will need your current password to do it.",
  notifications: "Which of the firm's notifications reach you, and whether by email too.",
};

export function ProfilePage() {
  const { user } = useAuth();
  // the tab lives in the URL, so it survives a refresh and can be linked to
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab: Tab = TABS.some((t) => t.value === raw) ? (raw as Tab) : "account";
  const setTab = (next: Tab) =>
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        out.set("tab", next);
        return out;
      },
      { replace: true }, // tab clicks are not history
    );

  if (!user) return null;

  return (
    <div className="mx-auto max-w-[960px]">
      <div className="mb-3.5 flex min-h-9 flex-wrap items-center gap-3.5">
        <h1 className="text-[20px] font-semibold">Profile</h1>
        <span className="text-[13px] text-muted-400">{BLURB[tab]}</span>
      </div>

      <Tabs className="mb-4" value={tab} onChange={setTab} options={TABS} />

      {tab === "account" && (
        <div className="max-w-lg space-y-6">
          <AvatarSection />
          <NameSection defaults={{ firstName: user.firstName, lastName: user.lastName }} />
        </div>
      )}
      {tab === "password" && (
        <div className="max-w-lg">
          <PasswordSection />
        </div>
      )}
      {/* the personal contour (S9). Full width, unlike the forms: two channel switches per
          trigger do not fit a form column. */}
      {tab === "notifications" && (
        // the tab is already called Notifications; a heading repeating it inside the panel is
        // the same word twice on one screen
        <div className="rounded-(--radius-panel) border border-border bg-surface p-5 shadow-(--shadow-card)">
          <Suspense fallback={<p className="text-[13px] text-muted">Loading…</p>}>
            <NotificationPreferences />
          </Suspense>
        </div>
      )}
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
    try {
      await upload.mutateAsync(file);
      setVersion((v) => v + 1);
    } catch {
      /* surfaced via serverError below */
    }
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
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<NameValues>({ resolver: zodResolver(nameSchema), defaultValues: defaults });

  const serverError = update.error instanceof ApiError ? update.error.message : null;

  return (
    <Section title="Name">
      <form
        onSubmit={handleSubmit(async (v) => {
          try {
            await update.mutateAsync(v);
            reset(v); // clears isDirty → the "Saved" label can appear
          } catch {
            /* surfaced via serverError below */
          }
        })}
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
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
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
    try {
      await update.mutateAsync({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      reset();
    } catch {
      /* surfaced via serverError below */
    }
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

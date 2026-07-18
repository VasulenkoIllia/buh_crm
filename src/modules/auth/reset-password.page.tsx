import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { password } from "@shared/schema/user";
import { api, ApiError } from "@/shared/lib/api";
import { Button } from "@/shared/ui/button";
import { FormField, Input } from "@/shared/ui/field";
import { AuthCard } from "./auth-card";

const formSchema = z
  .object({ password, confirm: z.string() })
  .refine((v) => v.password === v.confirm, {
    path: ["confirm"],
    message: "Passwords do not match",
  });
type FormValues = z.infer<typeof formSchema>;

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";

  const reset = useMutation({
    mutationFn: (values: FormValues) =>
      api<{ ok: true }>("/api/auth/reset-password", {
        method: "POST",
        body: { token, password: values.password },
      }),
  });

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(formSchema) });

  if (reset.isSuccess) {
    return (
      <AuthCard title="Password updated">
        <p className="text-center text-[13px] text-muted">
          Your password has been changed. Sign in with the new one.
        </p>
        <p className="mt-4 text-center">
          <Link to="/sign-in" className="text-[12px] text-primary-link hover:underline">
            Go to sign in
          </Link>
        </p>
      </AuthCard>
    );
  }

  const serverError = reset.error instanceof ApiError ? reset.error.message : null;

  return (
    <AuthCard title="Set a new password">
      <form onSubmit={handleSubmit((v) => reset.mutateAsync(v))} className="space-y-4" noValidate>
        <FormField label="New password" htmlFor="password" error={errors.password?.message}>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            placeholder="At least 8 characters"
            error={!!errors.password}
            {...register("password")}
          />
        </FormField>
        <FormField label="Confirm password" htmlFor="confirm" error={errors.confirm?.message}>
          <Input
            id="confirm"
            type="password"
            autoComplete="new-password"
            placeholder="Repeat the password"
            error={!!errors.confirm}
            {...register("confirm")}
          />
        </FormField>
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Save password"}
        </Button>
      </form>
    </AuthCard>
  );
}

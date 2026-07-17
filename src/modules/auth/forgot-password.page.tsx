import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link } from "react-router-dom";
import { forgotPasswordInput, type ForgotPasswordInput } from "@shared/schema/user";
import { api } from "@/shared/lib/api";
import { Button } from "@/shared/ui/button";
import { FormField, Input } from "@/shared/ui/field";
import { AuthCard } from "./auth-card";

export function ForgotPasswordPage() {
  const request = useMutation({
    mutationFn: (values: ForgotPasswordInput) =>
      api<{ ok: true }>("/api/auth/forgot-password", { method: "POST", body: values }),
  });

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordInput>({ resolver: zodResolver(forgotPasswordInput) });

  if (request.isSuccess) {
    return (
      <AuthCard title="Check your email">
        <p className="text-center text-[13px] text-muted">
          If an account with that email exists, we sent a reset link. It expires in 1 hour.
        </p>
        <p className="mt-4 text-center">
          <Link to="/sign-in" className="text-[12px] text-primary-link hover:underline">
            Back to sign in
          </Link>
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Reset password">
      <form
        onSubmit={handleSubmit((v) => request.mutateAsync(v))}
        className="space-y-4"
        noValidate
      >
        <FormField label="Email" htmlFor="email" error={errors.email?.message}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            error={!!errors.email}
            {...register("email")}
          />
        </FormField>
        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? "Sending…" : "Send reset link"}
        </Button>
        <p className="text-center">
          <Link to="/sign-in" className="text-[12px] text-primary-link hover:underline">
            Back to sign in
          </Link>
        </p>
      </form>
    </AuthCard>
  );
}

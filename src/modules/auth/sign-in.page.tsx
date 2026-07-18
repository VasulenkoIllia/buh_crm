import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { loginInput, type LoginInput } from "@shared/schema/user";
import { useLogin } from "@/app/auth";
import { ApiError } from "@/shared/lib/api";
import { Button } from "@/shared/ui/button";
import { FormField, Input } from "@/shared/ui/field";
import { AuthCard } from "./auth-card";

export function SignInPage() {
  const login = useLogin();
  const navigate = useNavigate();
  const location = useLocation();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(loginInput) });

  const onSubmit = handleSubmit(async (values) => {
    await login.mutateAsync(values);
    navigate((location.state as { from?: string } | null)?.from ?? "/", { replace: true });
  });

  const serverError =
    login.error instanceof ApiError ? login.error.message : login.error ? "Sign-in failed" : null;

  return (
    <AuthCard title="Sign in">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormField label="Email" htmlFor="email" error={errors.email?.message}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@firm.com"
            error={!!errors.email}
            {...register("email")}
          />
        </FormField>
        <FormField label="Password" htmlFor="password" error={errors.password?.message}>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            placeholder="Your password"
            error={!!errors.password}
            {...register("password")}
          />
        </FormField>
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? "Signing in…" : "Sign in"}
        </Button>
        <p className="text-center">
          <Link to="/forgot-password" className="text-[12px] text-primary-link hover:underline">
            Forgot password?
          </Link>
        </p>
      </form>
    </AuthCard>
  );
}

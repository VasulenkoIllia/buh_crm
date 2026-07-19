import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { password, type PublicUser } from "@shared/schema/user";
import { ME_QUERY_KEY } from "@/app/auth";
import { api, ApiError } from "@/shared/lib/api";
import { Button } from "@/shared/ui/button";
import { FormField, Input } from "@/shared/ui/field";
import { AuthCard } from "./auth-card";

const formSchema = z
  .object({
    firstName: z.string().min(1, "Required"),
    lastName: z.string().min(1, "Required"),
    password,
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    path: ["confirm"],
    message: "Passwords do not match",
  });
type FormValues = z.infer<typeof formSchema>;

/** Invite acceptance: set name + password → account becomes active (auto-login). */
export function SetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const accept = useMutation({
    mutationFn: (values: FormValues) =>
      api<PublicUser>("/api/auth/accept-invite", {
        method: "POST",
        body: {
          token,
          firstName: values.firstName,
          lastName: values.lastName,
          password: values.password,
        },
      }),
    onSuccess: (user) => {
      queryClient.setQueryData(ME_QUERY_KEY, user);
      navigate("/", { replace: true });
    },
  });

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(formSchema) });

  if (!token) {
    return (
      <AuthCard title="Invalid link">
        <p className="text-center text-[13px] text-muted">
          This invite link is missing its token. Ask an admin to resend the invitation.
        </p>
      </AuthCard>
    );
  }

  const serverError = accept.error instanceof ApiError ? accept.error.message : null;

  return (
    <AuthCard title="Set up your account">
      <form
        onSubmit={handleSubmit(async (v) => {
          await accept.mutateAsync(v).catch(() => {
            /* surfaced via serverError below */
          });
        })}
        className="space-y-4"
        noValidate
      >
        <div className="grid grid-cols-2 gap-3">
          <FormField label="First name" htmlFor="firstName" error={errors.firstName?.message}>
            <Input
              id="firstName"
              placeholder="e.g. Ivan"
              error={!!errors.firstName}
              {...register("firstName")}
            />
          </FormField>
          <FormField label="Last name" htmlFor="lastName" error={errors.lastName?.message}>
            <Input
              id="lastName"
              placeholder="e.g. Petrenko"
              error={!!errors.lastName}
              {...register("lastName")}
            />
          </FormField>
        </div>
        <FormField label="Password" htmlFor="password" error={errors.password?.message}>
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
          {isSubmitting ? "Activating…" : "Activate account"}
        </Button>
      </form>
    </AuthCard>
  );
}

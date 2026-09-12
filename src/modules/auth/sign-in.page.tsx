import { useState, type FormEvent } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { loginInput, type LoginInput } from "@shared/schema/user";
import { isChallenge, useLogin, useLoginSecondFactor } from "@/app/auth";
import { ApiError } from "@/shared/lib/api";
import { Button } from "@/shared/ui/button";
import { FormField, Input } from "@/shared/ui/field";
import { AuthCard } from "./auth-card";

/**
 * Signing in — in two steps when the account has a second factor (docs/modules/two-factor.md §5).
 *
 * The challenge lives only in this component's state. Reloading the page, or taking longer than the
 * challenge's five minutes, sends the person back to their password — which is what the server
 * would do anyway.
 */
export function SignInPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [challenge, setChallenge] = useState<{ token: string; email: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const done = () =>
    navigate((location.state as { from?: string } | null)?.from ?? "/", { replace: true });

  if (challenge) {
    return (
      <CodeStep
        challenge={challenge}
        onDone={done}
        onRestart={(message) => {
          setChallenge(null);
          setNotice(message);
        }}
      />
    );
  }
  return (
    <PasswordStep
      notice={notice}
      onDone={done}
      onChallenge={(token, email) => {
        setNotice(null);
        setChallenge({ token, email });
      }}
    />
  );
}

function PasswordStep({
  notice,
  onDone,
  onChallenge,
}: {
  notice: string | null;
  onDone: () => void;
  onChallenge: (token: string, email: string) => void;
}) {
  const login = useLogin();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(loginInput) });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const result = await login.mutateAsync(values);
      if (isChallenge(result)) onChallenge(result.challenge, values.email);
      else onDone();
    } catch {
      /* surfaced via serverError below */
    }
  });

  const serverError =
    login.error instanceof ApiError
      ? login.error.message
      : login.error
        ? "Sign-in failed"
        : null;

  return (
    <AuthCard title="Sign in">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {notice && !serverError && (
          <p className="rounded-(--radius-field) bg-app-bg px-3 py-2 text-[12px] text-muted">
            {notice}
          </p>
        )}
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

/** Step two: a code from the app — or, without the phone, one of the recovery codes (§7). */
function CodeStep({
  challenge,
  onDone,
  onRestart,
}: {
  challenge: { token: string; email: string };
  onDone: () => void;
  onRestart: (message: string | null) => void;
}) {
  const second = useLoginSecondFactor();
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await second.mutateAsync({ challenge: challenge.token, code });
      onDone();
    } catch (error) {
      // a spent, expired or exhausted challenge: back to the password, saying why
      if (error instanceof ApiError && error.code === "challenge_expired") {
        onRestart(error.message);
      }
    }
  };

  const serverError =
    second.error instanceof ApiError
      ? second.error.code === "challenge_expired"
        ? null
        : second.error.message
      : second.error
        ? "Sign-in failed"
        : null;

  return (
    <AuthCard title="Two-factor sign-in">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <p className="text-center text-[13px] text-muted">
          {recovery
            ? "Enter one of your recovery codes. Each works once."
            : "Enter the six-digit code from your authenticator app."}
          <br />
          <span className="text-ink">{challenge.email}</span>
        </p>
        <FormField label={recovery ? "Recovery code" : "Code"} htmlFor="code">
          <Input
            id="code"
            autoFocus
            inputMode={recovery ? "text" : "numeric"}
            autoComplete={recovery ? "off" : "one-time-code"}
            maxLength={recovery ? 16 : 7}
            placeholder={recovery ? "abcde-fghjk" : "123 456"}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </FormField>
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
        <Button type="submit" className="w-full" disabled={second.isPending || !code.trim()}>
          {second.isPending ? "Checking…" : "Sign in"}
        </Button>
        <div className="flex justify-between text-[12px]">
          <button
            type="button"
            className="text-primary-link hover:underline"
            onClick={() => {
              setRecovery(!recovery);
              setCode("");
              second.reset();
            }}
          >
            {recovery ? "Use the app instead" : "Use a recovery code"}
          </button>
          <button
            type="button"
            className="text-muted hover:underline"
            onClick={() => onRestart(null)}
          >
            Back
          </button>
        </div>
      </form>
    </AuthCard>
  );
}

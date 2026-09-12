import { useState, type FormEvent } from "react";
import { Copy, Download, ShieldCheck } from "lucide-react";
import type { TwoFactorSetup, TwoFactorStatus } from "@shared/schema/two-factor";
import { plural } from "@shared/text";
import { ApiError } from "@/shared/lib/api";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { FormField, Input } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import {
  useBeginTwoFactorSetup,
  useConfirmTwoFactor,
  useDisableTwoFactor,
  useRegenerateRecoveryCodes,
  useTwoFactorStatus,
} from "./two-factor.api";

/**
 * **Profile → Two-factor** (docs/modules/two-factor.md §6).
 *
 * Reads as an offer rather than a warning, because taking part is each person's choice — unless the
 * firm's rule covers them, and then it says so first. Every change re-asks for the password; the
 * dialogs live outside the on/off branch, so switching it on does not unmount the one screen that
 * shows the recovery codes.
 */
export function TwoFactorSection() {
  const { data: status, isLoading, error } = useTwoFactorStatus();
  const [dialog, setDialog] = useState<"enable" | "codes" | "disable" | null>(null);
  const close = () => setDialog(null);

  return (
    <section className="rounded-(--radius-panel) border border-border bg-surface p-5 shadow-(--shadow-card)">
      <h2 className="mb-3 text-[15px] font-semibold">Two-factor sign-in</h2>
      {isLoading ? (
        <p className="text-[13px] text-muted">Loading…</p>
      ) : error || !status ? (
        <p className="text-[13px] text-danger-text">Two-factor sign-in could not be loaded.</p>
      ) : (
        <>
          <RequirementNotice status={status} />
          {status.enabled ? (
            <Enabled
              status={status}
              onCodes={() => setDialog("codes")}
              onDisable={() => setDialog("disable")}
            />
          ) : (
            <Offer status={status} onStart={() => setDialog("enable")} />
          )}
        </>
      )}
      <EnableDialog open={dialog === "enable"} onClose={close} />
      <RecoveryCodesDialog open={dialog === "codes"} onClose={close} />
      <DisableDialog open={dialog === "disable"} onClose={close} />
    </section>
  );
}

const fmtDay = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(new Date(iso))
    : "";

const errorText = (error: unknown) =>
  error instanceof ApiError ? error.message : error ? "Something went wrong. Try again." : null;

function RequirementNotice({ status }: { status: TwoFactorStatus }) {
  if (!status.required || status.enabled) return null;
  return (
    <p className="mb-4 rounded-(--radius-field) border border-[#f1dcb6] bg-[#fdf6ea] px-3 py-2.5 text-[13px] text-[#8a5a14]">
      {status.mustEnrol
        ? "Your firm requires two-factor sign-in. Until you turn it on, the rest of the CRM stays closed to your account."
        : `Your firm requires two-factor sign-in. Turn it on before ${fmtDay(status.graceEndsAt)} — after that, only this page opens until you do.`}
    </p>
  );
}

function Offer({ status, onStart }: { status: TwoFactorStatus; onStart: () => void }) {
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        Signing in will ask for a six-digit code from an authenticator app on your phone —
        Google Authenticator, Microsoft Authenticator, 1Password or similar — as well as your
        password. Then somebody who learns your password still cannot get in.
      </p>
      {status.available ? (
        <Button onClick={onStart}>Turn on two-factor sign-in</Button>
      ) : (
        <p className="text-[12px] text-muted">
          Not available yet: the server needs one more setting first. Ask an admin.
        </p>
      )}
    </div>
  );
}

function Enabled({
  status,
  onCodes,
  onDisable,
}: {
  status: TwoFactorStatus;
  onCodes: () => void;
  onDisable: () => void;
}) {
  const low = status.recoveryCodesLeft < 3;
  return (
    <div className="space-y-3">
      <p className="flex items-center gap-2 text-[13px]">
        <ShieldCheck size={16} className="shrink-0 text-success" />
        On since {fmtDay(status.enabledAt)}. Signing in asks for a code from your app.
      </p>
      <p className={cn("text-[13px]", low ? "text-danger-text" : "text-muted")}>
        {plural(status.recoveryCodesLeft, "recovery code")} left.
        {low &&
          " Make new ones before you run out — they are your way back in if the phone is lost."}
      </p>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onCodes}>
          New recovery codes
        </Button>
        <Button variant="secondary" onClick={onDisable}>
          Turn off
        </Button>
      </div>
    </div>
  );
}

// ── the dialogs ──────────────────────────────────────────────────────────────

type EnableStep =
  | { kind: "password" }
  | { kind: "scan"; setup: TwoFactorSetup }
  | { kind: "codes"; codes: string[] };

/** Password → scan and confirm with a code → the ten recovery codes, shown this once (§6.1). */
function EnableDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const begin = useBeginTwoFactorSetup();
  const confirm = useConfirmTwoFactor();
  const [step, setStep] = useState<EnableStep>({ kind: "password" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [saved, setSaved] = useState(false);

  const close = () => {
    setStep({ kind: "password" });
    setPassword("");
    setCode("");
    setSaved(false);
    begin.reset();
    confirm.reset();
    onClose();
  };

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const setup = await begin.mutateAsync(password);
      setPassword("");
      setStep({ kind: "scan", setup });
    } catch {
      /* surfaced below */
    }
  };

  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const { recoveryCodes } = await confirm.mutateAsync(code);
      setStep({ kind: "codes", codes: recoveryCodes });
    } catch {
      /* surfaced below */
    }
  };

  const footer =
    step.kind === "codes" ? (
      <Button onClick={close} disabled={!saved}>
        Done
      </Button>
    ) : (
      <>
        <Button variant="secondary" onClick={close}>
          Cancel
        </Button>
        {step.kind === "password" ? (
          <Button type="submit" form="tf-password" disabled={begin.isPending || !password}>
            {begin.isPending ? "Checking…" : "Continue"}
          </Button>
        ) : (
          <Button type="submit" form="tf-scan" disabled={confirm.isPending || !code.trim()}>
            {confirm.isPending ? "Checking…" : "Turn on"}
          </Button>
        )}
      </>
    );

  return (
    <Modal
      title="Turn on two-factor sign-in"
      open={open}
      onClose={close}
      size="md"
      footer={footer}
    >
      {step.kind === "password" && (
        <form id="tf-password" onSubmit={submitPassword} className="space-y-3" noValidate>
          <p className="text-[13px] text-muted">
            Your password first, so nobody at an unlocked computer can do this for you.
          </p>
          <FormField label="Your password" htmlFor="tf-password-input">
            <Input
              id="tf-password-input"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </FormField>
          {errorText(begin.error) && (
            <p className="text-[12px] text-danger-text">{errorText(begin.error)}</p>
          )}
        </form>
      )}

      {step.kind === "scan" && (
        <form id="tf-scan" onSubmit={submitCode} className="space-y-4" noValidate>
          <ol className="list-decimal space-y-1 pl-5 text-[13px] text-muted">
            <li>In your authenticator app, add an account.</li>
            <li>Scan this code — or type the key beside it.</li>
            <li>Enter the six-digit code the app then shows.</li>
          </ol>
          <div className="flex items-center gap-4">
            <img
              src={step.setup.qrDataUrl}
              alt="QR code to scan with your authenticator app"
              width={168}
              height={168}
              className="shrink-0 rounded-(--radius-field) border border-border"
            />
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-400">
                Key
              </div>
              <code className="block break-all font-mono text-[13px]">{step.setup.secret}</code>
            </div>
          </div>
          <FormField label="Code from the app" htmlFor="tf-code">
            <Input
              id="tf-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={7}
              placeholder="123 456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </FormField>
          {errorText(confirm.error) && (
            <p className="text-[12px] text-danger-text">{errorText(confirm.error)}</p>
          )}
        </form>
      )}

      {step.kind === "codes" && (
        <RecoveryCodesList codes={step.codes} saved={saved} onSaved={setSaved} />
      )}
    </Modal>
  );
}

/** New codes: the password, then the ten — every old one stops working (§6.2). */
function RecoveryCodesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const regenerate = useRegenerateRecoveryCodes();
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);

  const close = () => {
    setPassword("");
    setCodes(null);
    setSaved(false);
    regenerate.reset();
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const result = await regenerate.mutateAsync(password);
      setPassword("");
      setCodes(result.recoveryCodes);
    } catch {
      /* surfaced below */
    }
  };

  return (
    <Modal
      title="New recovery codes"
      open={open}
      onClose={close}
      size="md"
      footer={
        codes ? (
          <Button onClick={close} disabled={!saved}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="tf-regenerate"
              disabled={regenerate.isPending || !password}
            >
              {regenerate.isPending ? "Making…" : "Make new codes"}
            </Button>
          </>
        )
      }
    >
      {codes ? (
        <RecoveryCodesList codes={codes} saved={saved} onSaved={setSaved} />
      ) : (
        <form id="tf-regenerate" onSubmit={submit} className="space-y-3" noValidate>
          <p className="text-[13px] text-muted">
            Ten new codes replace the ones you have — every old code stops working.
          </p>
          <FormField label="Your password" htmlFor="tf-regenerate-password">
            <Input
              id="tf-regenerate-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </FormField>
          {errorText(regenerate.error) && (
            <p className="text-[12px] text-danger-text">{errorText(regenerate.error)}</p>
          )}
        </form>
      )}
    </Modal>
  );
}

/** The password AND a code — the password alone is what an attacker would have (§6.3). */
function DisableDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const disable = useDisableTwoFactor();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");

  const close = () => {
    setPassword("");
    setCode("");
    disable.reset();
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await disable.mutateAsync({ password, code });
      close();
    } catch {
      /* surfaced below */
    }
  };

  return (
    <Modal
      title="Turn off two-factor sign-in"
      open={open}
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            type="submit"
            form="tf-disable"
            disabled={disable.isPending || !password || !code.trim()}
          >
            {disable.isPending ? "Turning off…" : "Turn off"}
          </Button>
        </>
      }
    >
      <form id="tf-disable" onSubmit={submit} className="space-y-3" noValidate>
        <p className="text-[13px] text-muted">
          Signing in will need only your password again. Every other place you are signed in
          will be signed out.
        </p>
        <FormField label="Your password" htmlFor="tf-disable-password">
          <Input
            id="tf-disable-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </FormField>
        <FormField label="Code from the app, or a recovery code" htmlFor="tf-disable-code">
          <Input
            id="tf-disable-code"
            autoComplete="one-time-code"
            placeholder="123 456"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </FormField>
        {errorText(disable.error) && (
          <p className="text-[12px] text-danger-text">{errorText(disable.error)}</p>
        )}
      </form>
    </Modal>
  );
}

/**
 * The ten codes, this once. "Done" waits for the tick: the codes are the only way back in without
 * the phone, and a dialog closed by reflex before they were saved is how people lose them.
 */
function RecoveryCodesList({
  codes,
  saved,
  onSaved,
}: {
  codes: string[];
  saved: boolean;
  onSaved: (value: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const download = () => {
    const blob = new Blob([`Recovery codes — each one works once.\n\n${text}\n`], {
      type: "text/plain",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      <p className="text-[13px]">
        These codes get you in if you lose your phone. Each works once.{" "}
        <strong>This is the only time you will see them</strong> — keep them in the firm&apos;s
        password manager.
      </p>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-(--radius-field) border border-border bg-app-bg px-4 py-3 font-mono text-[13px]">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" onClick={() => void copy()}>
          <Copy size={14} /> {copied ? "Copied" : "Copy"}
        </Button>
        <Button variant="secondary" size="sm" onClick={download}>
          <Download size={14} /> Download
        </Button>
      </div>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={saved} onChange={(e) => onSaved(e.target.checked)} />I
        have saved these codes
      </label>
    </div>
  );
}

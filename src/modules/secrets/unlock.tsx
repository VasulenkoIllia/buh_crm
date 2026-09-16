import { useEffect, useState } from "react";
import { Lock, LockOpen } from "lucide-react";
import { ApiError } from "@/shared/lib/api";
import { Button } from "@/shared/ui/button";
import { FormField, Input } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { useUnlockVault, useVaultGrant } from "./secrets.api";

/**
 * **One unlock, the whole vault, five minutes** (secrets.md §6). The window belongs to the SESSION,
 * so unlocking here opens nothing on another computer, and the SERVER counts the minutes — a
 * countdown in the browser is decoration.
 */
export function useVaultWindow() {
  const { data } = useVaultGrant();
  const expiresAt = data?.expiresAt ?? null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  const left = expiresAt ? new Date(expiresAt).getTime() - now : 0;
  return { unlocked: left > 0, secondsLeft: Math.max(0, Math.ceil(left / 1000)) };
}

const mmss = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** The one bar the whole screen shares, and the client card with it. */
export function VaultBar({ onUnlock }: { onUnlock: () => void }) {
  const { unlocked, secondsLeft } = useVaultWindow();
  return (
    <div
      className={
        unlocked
          ? "flex items-center gap-2.5 rounded-(--radius-card) border border-[#e0d3b8] bg-[#fdf8ee] px-3.5 py-2 text-[13px]"
          : "flex items-center gap-2.5 rounded-(--radius-card) border border-border bg-surface px-3.5 py-2 text-[13px]"
      }
    >
      {unlocked ? (
        <>
          <LockOpen size={15} className="text-[#8a5a00]" />
          <span className="text-ink-700">
            Open for <b className="tabular-nums text-[#8a5a00]">{mmss(secondsLeft)}</b>
          </span>
        </>
      ) : (
        <>
          <Lock size={15} className="text-muted" />
          <span className="text-ink-700">Enter your password to see values.</span>
          <span className="flex-1" />
          <Button variant="secondary" size="sm" onClick={onUnlock}>
            Unlock
          </Button>
        </>
      )}
    </div>
  );
}

/** Re-authentication with the viewer's OWN password; a wrong one is journalled, and says which. */
export function UnlockModal({ onClose, onDone }: { onClose: () => void; onDone?: () => void }) {
  const unlock = useUnlockVault();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      await unlock.mutateAsync({ password });
      setPassword(""); // not a moment longer in state than it has to be
      // `onDone` first: the screen behind still holds the old "locked" until the grant refetches,
      // so what the unlock was FOR has to be told it succeeded before this window goes
      onDone?.();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not unlock");
    } finally {
      // the mutation's variables are the person's own sign-in password: reset lets go of them, after
      // a wrong one as much as a right one, and the hook's `gcTime: 0` removes them at once
      unlock.reset();
    }
  };

  return (
    <Modal
      title="Unlock the vault"
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!password || unlock.isPending} onClick={() => void submit()}>
            {unlock.isPending ? "Checking…" : "Unlock for 5 minutes"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[13px] text-muted">
          Enter <strong>your own</strong> password. Five minutes, on this computer, for every
          secret you can see. Each look is written to the log.
        </p>
        <FormField label="Your password" htmlFor="vault-pass">
          <Input
            id="vault-pass"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && password && void submit()}
          />
        </FormField>
        {error && (
          <div className="space-y-1">
            <p className="text-[12px] text-danger-text">{error}</p>
            {/* the vault has no password of its own, so the way out is an ordinary reset */}
            <p className="text-[12px] text-muted">
              Forgotten it? Sign out and use <strong>Forgot password</strong> on the sign-in
              screen. The new one works here too.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}

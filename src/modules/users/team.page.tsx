import { useState, type FormEvent } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { inviteUserInput, type InviteUserInput, type PublicUser } from "@shared/schema/user";
import type { TwoFactorPolicy, TwoFactorTeamOverview } from "@shared/schema/two-factor";
import { useAuth } from "@/app/auth";
import { ApiError } from "@/shared/lib/api";
import { UserAvatar } from "@/shared/ui/avatar";
import { Button } from "@/shared/ui/button";
import { FormField, Input, Select } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { StatusPill } from "@/shared/ui/pill";
import { Segmented } from "@/shared/ui/segmented";
import { useResetTwoFactor, useSetTwoFactorPolicy, useTwoFactorTeam } from "./two-factor.api";
import { useInviteUser, useResendInvite, useUpdateUser, useUsers } from "./users.api";

export function TeamPage() {
  const { user: me } = useAuth();
  const { data: users, isLoading, error } = useUsers();
  const twoFactor = useTwoFactorTeam();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [resetting, setResetting] = useState<PublicUser | null>(null);

  if (me?.role !== "admin") {
    return <p className="text-[13px] text-muted">Only admins can manage the team.</p>;
  }
  if (isLoading) return <p className="text-[13px] text-muted">Loading…</p>;
  if (error) return <p className="text-[13px] text-danger-text">Failed to load the team.</p>;

  // who has a second factor, by id; undefined while it loads, so the column says nothing rather
  // than a wrong "Off" for everybody
  const enabled = twoFactor.data
    ? new Set(twoFactor.data.members.map((m) => m.userId))
    : undefined;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-[20px] font-semibold">Team</h1>
        <Button onClick={() => setInviteOpen(true)}>Invite user</Button>
      </div>

      <TwoFactorPanel overview={twoFactor.data} users={users ?? []} enabled={enabled} />

      <div className="overflow-x-auto rounded-(--radius-panel) border border-border bg-surface shadow-(--shadow-card)">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-border text-[11px] font-semibold uppercase tracking-wide text-muted-400">
              <th className="px-4 py-3">User</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Status</th>
              <th className="whitespace-nowrap px-4 py-3">Two-factor</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(users ?? []).map((user) => (
              <UserRow
                key={user.id}
                user={user}
                isSelf={user.id === me.id}
                twoFactorOn={enabled ? enabled.has(user.id) : undefined}
                onReset={() => setResetting(user)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <InviteModal open={inviteOpen} onClose={() => setInviteOpen(false)} />
      <ResetTwoFactorModal user={resetting} onClose={() => setResetting(null)} />
    </div>
  );
}

// ── two-factor sign-in: who has it, and the firm's rule (two-factor.md §3.1, §6.4) ──

const POLICY_OPTIONS: { value: TwoFactorPolicy; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "admins", label: "Admins" },
  { value: "everyone", label: "Everyone" },
];

const fmtDay = (date: Date) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(
    date,
  );

function describeRule(overview: TwoFactorTeamOverview): string {
  if (overview.policy === "off") return "Each person decides for themselves.";
  const who = overview.policy === "admins" ? "admins" : "everyone";
  const ends = overview.graceEndsAt ? new Date(overview.graceEndsAt) : null;
  if (ends && ends.getTime() > Date.now()) {
    return `Required for ${who} — anyone without it has until ${fmtDay(ends)}.`;
  }
  return `Required for ${who} — anyone without it can open only their profile until they turn it on.`;
}

/**
 * **The number and the decision it informs, on one screen.** Voluntary two-factor sign-in that
 * nobody can measure is a control nobody can manage (§3.1); the switch beside the count is where
 * that turns into a rule.
 */
function TwoFactorPanel({
  overview,
  users,
  enabled,
}: {
  overview: TwoFactorTeamOverview | undefined;
  users: PublicUser[];
  enabled: Set<string> | undefined;
}) {
  const setPolicy = useSetTwoFactorPolicy();
  const active = users.filter((u) => u.status === "active");
  const on = enabled ? active.filter((u) => enabled.has(u.id)).length : null;

  const change = (policy: TwoFactorPolicy) => {
    if (!overview || policy === overview.policy || setPolicy.isPending) return;
    const warning =
      policy === "off"
        ? "Two-factor sign-in stops being required. Everybody who has it keeps it."
        : `${policy === "admins" ? "Admins" : "Everybody"} without two-factor sign-in get 14 days ` +
          "to turn it on. After that, only their profile opens until they do.";
    if (!window.confirm(`${warning}\n\nChange the rule?`)) return;
    setPolicy.mutate(policy);
  };

  return (
    <section className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-(--radius-panel) border border-border bg-surface px-5 py-4 shadow-(--shadow-card)">
      <div className="min-w-0 flex-1">
        <h2 className="text-[14px] font-semibold">Two-factor sign-in</h2>
        <p className="text-[12px] text-muted">
          {on === null
            ? "Loading…"
            : `${on} of ${active.length} active ${active.length === 1 ? "person has" : "people have"} it on.`}{" "}
          {overview && describeRule(overview)}
        </p>
        {setPolicy.error && (
          <p className="mt-1 text-[12px] text-danger-text">
            {setPolicy.error instanceof ApiError
              ? setPolicy.error.message
              : "The rule could not be changed."}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="whitespace-nowrap text-[12px] text-muted">Required for</span>
        <div className="w-60">
          <Segmented
            value={overview?.policy ?? "off"}
            onChange={change}
            options={POLICY_OPTIONS}
          />
        </div>
      </div>
    </section>
  );
}

function TwoFactorCell({
  status,
  on,
}: {
  status: PublicUser["status"];
  on: boolean | undefined;
}) {
  if (on === undefined || status === "invited") return <span className="text-muted">—</span>;
  return (
    <span
      className="inline-flex items-center rounded-(--radius-chip) px-2 py-0.5 text-[12px] font-medium"
      style={
        on
          ? { color: "#1f8f3a", backgroundColor: "#e6f4ea" }
          : { color: "#6b7280", backgroundColor: "#eef0f3" }
      }
    >
      {on ? "On" : "Off"}
    </span>
  );
}

/**
 * **An admin's reset** (§7): the admin's own password, never on their own row — their own comes
 * off from their profile, with a code. What it does is said before it is done, because it signs
 * the person out everywhere and tells them and every other admin.
 */
function ResetTwoFactorModal({
  user,
  onClose,
}: {
  user: PublicUser | null;
  onClose: () => void;
}) {
  const reset = useResetTwoFactor();
  const [password, setPassword] = useState("");
  const name = user ? `${user.firstName} ${user.lastName}`.trim() || user.email : "";

  const close = () => {
    setPassword("");
    reset.reset();
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!user) return;
    try {
      await reset.mutateAsync({ id: user.id, password });
      close();
    } catch {
      /* surfaced below */
    }
  };

  return (
    <Modal
      title="Reset two-factor sign-in"
      open={user !== null}
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            type="submit"
            form="reset-2fa-form"
            disabled={reset.isPending || !password}
          >
            {reset.isPending ? "Resetting…" : "Reset"}
          </Button>
        </>
      }
    >
      <form id="reset-2fa-form" onSubmit={submit} className="space-y-3" noValidate>
        <p className="text-[13px]">
          {name} will be signed out everywhere and will need to set up their authenticator again
          from their profile. They and the other admins get an email saying you did this.
        </p>
        <FormField label="Your password" htmlFor="reset-2fa-password">
          <Input
            id="reset-2fa-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </FormField>
        {reset.error && (
          <p className="text-[12px] text-danger-text">
            {reset.error instanceof ApiError
              ? reset.error.message
              : "The reset did not go through."}
          </p>
        )}
      </form>
    </Modal>
  );
}

function UserRow({
  user,
  isSelf,
  twoFactorOn,
  onReset,
}: {
  user: PublicUser;
  isSelf: boolean;
  twoFactorOn: boolean | undefined;
  onReset: () => void;
}) {
  const updateUser = useUpdateUser();
  const resend = useResendInvite();

  const name = `${user.firstName} ${user.lastName}`.trim() || "—";

  return (
    <tr className="border-b border-divider last:border-0">
      <td className="px-4 py-2.5">
        <span className="flex items-center gap-2.5">
          <UserAvatar user={user} size="sm" />
          <span className="font-medium">
            {name}
            {isSelf && <span className="ml-1.5 text-[11px] text-muted">(you)</span>}
          </span>
        </span>
      </td>
      <td className="px-4 py-2.5 text-muted">{user.email}</td>
      <td className="px-4 py-2.5">
        {isSelf ? (
          <span className="capitalize">{user.role}</span>
        ) : (
          <Select
            className="h-7 w-24 text-[12px]"
            value={user.role}
            disabled={updateUser.isPending}
            onChange={(e) =>
              updateUser.mutate({
                id: user.id,
                input: { role: e.target.value as "admin" | "user" },
              })
            }
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </Select>
        )}
      </td>
      <td className="px-4 py-2.5">
        <StatusPill status={user.status} />
      </td>
      <td className="px-4 py-2.5">
        <TwoFactorCell status={user.status} on={twoFactorOn} />
      </td>
      <td className="px-4 py-2.5 text-right">
        {!isSelf && (
          <span className="inline-flex gap-1.5">
            {twoFactorOn && (
              <Button
                variant="secondary"
                size="sm"
                className="whitespace-nowrap"
                onClick={onReset}
              >
                Reset 2FA
              </Button>
            )}
            {user.status === "invited" && (
              <Button
                variant="secondary"
                size="sm"
                disabled={resend.isPending}
                onClick={() => resend.mutate(user.id)}
              >
                {resend.isSuccess ? "Sent" : "Resend invite"}
              </Button>
            )}
            {user.status === "active" && (
              <Button
                variant="destructive"
                size="sm"
                disabled={updateUser.isPending}
                onClick={() => updateUser.mutate({ id: user.id, input: { status: "blocked" } })}
              >
                Block
              </Button>
            )}
            {user.status === "blocked" && (
              <Button
                variant="secondary"
                size="sm"
                disabled={updateUser.isPending}
                onClick={() => updateUser.mutate({ id: user.id, input: { status: "active" } })}
              >
                Unblock
              </Button>
            )}
          </span>
        )}
      </td>
    </tr>
  );
}

function InviteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const invite = useInviteUser();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<InviteUserInput>({
    resolver: zodResolver(inviteUserInput),
    defaultValues: { role: "user" },
  });

  const close = () => {
    reset();
    invite.reset();
    onClose();
  };

  const onSubmit = handleSubmit(async (values) => {
    try {
      await invite.mutateAsync(values);
      close();
    } catch {
      /* surfaced via serverError below */
    }
  });

  const serverError = invite.error instanceof ApiError ? invite.error.message : null;

  return (
    <Modal
      title="Invite user"
      open={open}
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="invite-form" disabled={isSubmitting}>
            {isSubmitting ? "Sending…" : "Send invite"}
          </Button>
        </>
      }
    >
      <form id="invite-form" onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormField label="Email" htmlFor="invite-email" error={errors.email?.message}>
          <Input
            id="invite-email"
            type="email"
            placeholder="person@firm.com"
            error={!!errors.email}
            {...register("email")}
          />
        </FormField>
        <FormField label="Role" htmlFor="invite-role" error={errors.role?.message}>
          <Select id="invite-role" {...register("role")}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </Select>
        </FormField>
        {serverError && <p className="text-[12px] text-danger-text">{serverError}</p>}
        <p className="text-[12px] text-muted">
          They will get an email with a link to set a password and activate the account.
        </p>
      </form>
    </Modal>
  );
}

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { inviteUserInput, type InviteUserInput, type PublicUser } from "@shared/schema/user";
import { useAuth } from "@/app/auth";
import { ApiError } from "@/shared/lib/api";
import { UserAvatar } from "@/shared/ui/avatar";
import { Button } from "@/shared/ui/button";
import { FormField, Input, Select } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { StatusPill } from "@/shared/ui/pill";
import {
  useInviteUser,
  useResendInvite,
  useUpdateUser,
  useUsers,
} from "./users.api";

export function TeamPage() {
  const { user: me } = useAuth();
  const { data: users, isLoading, error } = useUsers();
  const [inviteOpen, setInviteOpen] = useState(false);

  if (me?.role !== "admin") {
    return (
      <p className="text-[13px] text-muted">Only admins can manage the team.</p>
    );
  }
  if (isLoading) return <p className="text-[13px] text-muted">Loading…</p>;
  if (error) return <p className="text-[13px] text-danger-text">Failed to load the team.</p>;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-[20px] font-semibold">Team</h1>
        <Button onClick={() => setInviteOpen(true)}>Invite user</Button>
      </div>

      <div className="overflow-x-auto rounded-(--radius-panel) border border-border bg-surface shadow-(--shadow-card)">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-border text-[11px] font-semibold uppercase tracking-wide text-muted-400">
              <th className="px-4 py-3">User</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users!.map((user) => (
              <UserRow key={user.id} user={user} isSelf={user.id === me.id} />
            ))}
          </tbody>
        </table>
      </div>

      <InviteModal open={inviteOpen} onClose={() => setInviteOpen(false)} />
    </div>
  );
}

function UserRow({ user, isSelf }: { user: PublicUser; isSelf: boolean }) {
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
      <td className="px-4 py-2.5 text-right">
        {!isSelf && (
          <span className="inline-flex gap-1.5">
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
    await invite.mutateAsync(values);
    close();
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

import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import type { MailSenderAccountDto } from "@shared/schema/mailouts";
import { Button } from "@/shared/ui/button";
import { FormField, Input, Textarea } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { Segmented } from "@/shared/ui/segmented";
import { useCreateSender, useUpdateSender } from "./mailouts.api";

/**
 * One mailbox, edited where the detail belongs.
 *
 * All of this used to live on the Sender page itself, which made the page a form for a single
 * mailbox rather than a view of all of them. Here the nine fields are the subject, not the noise.
 */
export function SenderAccountModal({
  open,
  account,
  server,
  onClose,
}: {
  open: boolean;
  account: MailSenderAccountDto | null;
  /** what the `.env` account is, so "the server's mailbox" names something rather than nothing */
  server: { label: string; fromEmail: string };
  onClose: () => void;
}) {
  const create = useCreateSender();
  const update = useUpdateSender();
  /**
   * Which account this mailbox sends over.
   *
   * A choice rather than an inference. It used to mean "leave the SMTP fields empty", which is a
   * rule you can only learn by reading a paragraph — and a half-filled host with no port looked
   * like a configured mailbox while behaving like an unconfigured one.
   */
  const [transport, setTransport] = useState<"server" | "own">("server");

  const [form, setForm] = useState({
    name: "",
    fromName: "",
    fromEmail: "",
    replyTo: "",
    signature: "",
    smtpHost: "",
    smtpPort: "",
    smtpUser: "",
    smtpPass: "",
    contactEmail: "",
    contactPhone: "",
    contactTelegram: "",
    contactWhatsapp: "",
    contactViber: "",
    contactWebsite: "",
  });
  const [secure, setSecure] = useState(false);
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm({
      name: account?.name ?? "",
      fromName: account?.fromName ?? "",
      fromEmail: account?.fromEmail ?? "",
      replyTo: account?.replyTo ?? "",
      signature: account?.signature ?? "",
      smtpHost: account?.smtpHost ?? "",
      smtpPort: account?.smtpPort ? String(account.smtpPort) : "",
      smtpUser: account?.smtpUser ?? "",
      smtpPass: "",
      contactEmail: account?.contactEmail ?? "",
      contactPhone: account?.contactPhone ?? "",
      contactTelegram: account?.contactTelegram ?? "",
      contactWhatsapp: account?.contactWhatsapp ?? "",
      contactViber: account?.contactViber ?? "",
      contactWebsite: account?.contactWebsite ?? "",
    });
    setSecure(account?.smtpSecure ?? false);
    setActive(account?.active ?? true);
    setTransport(account?.ownSmtp ? "own" : "server");
    setError(null);
  }, [open, account]);

  const set = (key: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [key]: v }));

  async function save() {
    setError(null);
    if (!form.name.trim()) return setError("Give the mailbox a name");

    const input = {
      name: form.name.trim(),
      fromName: form.fromName.trim() || form.name.trim(),
      fromEmail: form.fromEmail.trim(),
      replyTo: form.replyTo.trim(),
      signature: form.signature,
      // "server" clears every SMTP field, so the mailbox genuinely borrows `.env` rather than
      // keeping half a stale configuration the checks would then complain about
      smtpHost: transport === "own" ? form.smtpHost : "",
      smtpPort: transport === "own" && form.smtpPort ? Number(form.smtpPort) : null,
      smtpSecure: transport === "own" ? secure : null,
      smtpUser: transport === "own" ? form.smtpUser : "",
      active,
      contactEmail: form.contactEmail,
      contactPhone: form.contactPhone,
      contactTelegram: form.contactTelegram,
      contactWhatsapp: form.contactWhatsapp,
      contactViber: form.contactViber,
      contactWebsite: form.contactWebsite,
      // omitted when untouched, so saving the rest never wipes a stored password; switching to
      // the server mailbox clears it outright, since it can no longer be used
      ...(transport === "server"
        ? { smtpPass: "" }
        : form.smtpPass
          ? { smtpPass: form.smtpPass }
          : {}),
    };
    try {
      if (account) await update.mutateAsync({ id: account.id, input });
      else await create.mutateAsync(input);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    }
  }

  const busy = create.isPending || update.isPending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={account ? `Mailbox — ${account.name}` : "New mailbox"}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      }
    >
      {error && (
        <p className="mb-3 rounded-(--radius-field) bg-danger/10 px-3 py-2 text-[13px] text-danger-text">
          {error}
        </p>
      )}

      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Name — what you call it here">
            <Input
              value={form.name}
              onChange={(e) => set("name")(e.target.value)}
              placeholder="Newsletters"
            />
          </FormField>
          <FormField label="From name — what the client sees">
            <Input
              value={form.fromName}
              onChange={(e) => set("fromName")(e.target.value)}
              placeholder="ILLION Tax & Accounting"
            />
          </FormField>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="From address">
            <Input
              value={form.fromEmail}
              onChange={(e) => set("fromEmail")(e.target.value)}
              placeholder="info@illion.tax"
            />
          </FormField>
          <FormField label="Reply-To (optional)">
            <Input
              value={form.replyTo}
              onChange={(e) => set("replyTo")(e.target.value)}
              placeholder="If replies should land elsewhere"
            />
          </FormField>
        </div>

        <FormField label="Signature — the contact block at the foot of letters from here">
          <Textarea
            value={form.signature}
            onChange={(e) => set("signature")(e.target.value)}
            className="h-[110px] font-mono text-[12px]"
            placeholder={"Maryna Onyshchenko, EA, MBA\nAccountant | Tax & Accounting Services\n…"}
          />
        </FormField>
        <div className="border-t border-divider pt-3">
          <p className="text-[13px] font-semibold">Contact buttons</p>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">
            One button per filled field, in this order. Leave a field empty and its button does not
            appear — nothing is guessed from the signature above.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Email">
            <Input
              value={form.contactEmail}
              onChange={(e) => set("contactEmail")(e.target.value)}
              placeholder="info@illion.tax"
            />
          </FormField>
          <FormField label="Phone">
            <Input
              value={form.contactPhone}
              onChange={(e) => set("contactPhone")(e.target.value)}
              placeholder="+1 (704) 726-6994"
            />
          </FormField>
          <FormField label="Telegram — @username or a number">
            <Input
              value={form.contactTelegram}
              onChange={(e) => set("contactTelegram")(e.target.value)}
              placeholder="@illion_tax"
            />
          </FormField>
          <FormField label="WhatsApp">
            <Input
              value={form.contactWhatsapp}
              onChange={(e) => set("contactWhatsapp")(e.target.value)}
              placeholder="+1 (704) 726-6994"
            />
          </FormField>
          <FormField label="Viber">
            <Input
              value={form.contactViber}
              onChange={(e) => set("contactViber")(e.target.value)}
              placeholder="+1 (704) 726-6994"
            />
          </FormField>
          <FormField label="Website">
            <Input
              value={form.contactWebsite}
              onChange={(e) => set("contactWebsite")(e.target.value)}
              placeholder="illion.tax"
            />
          </FormField>
        </div>
        <p className="flex gap-1.5 text-[11px] leading-relaxed text-muted-400">
          <Info size={13} className="mt-0.5 shrink-0" />
          Four fit across a letter; the rest are dropped, website first — it is already a link in
          the signature above.
        </p>

        <div className="border-t border-divider pt-3">
          <p className="text-[13px] font-semibold">Sends over</p>
        </div>

        <Segmented
          value={transport}
          onChange={(v) => setTransport(v as "server" | "own")}
          options={[
            { value: "server", label: "The server's mailbox" },
            { value: "own", label: "Its own SMTP" },
          ]}
        />

        {transport === "server" ? (
          <div className="rounded-(--radius-field) border border-border bg-surface px-3 py-2.5">
            <p className="font-mono text-[12px] text-ink-700">{server.label}</p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
              The account that already sends invites and password resets. Nothing to configure, and
              it works today — which is why a new firm starts here.
            </p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
              It can normally only send as <span className="font-mono">{server.fromEmail}</span>. A
              different From is worth testing before the first real mailout, and once the firm sends
              in volume its own SMTP is safer: a spam complaint here damages the address the team
              needs to sign in.
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-[1fr_100px]">
              <FormField label="Host">
                <Input
                  value={form.smtpHost}
                  onChange={(e) => set("smtpHost")(e.target.value)}
                  placeholder="mail.illion.tax"
                />
              </FormField>
              <FormField label="Port">
                <Input
                  value={form.smtpPort}
                  onChange={(e) => set("smtpPort")(e.target.value.replace(/\D/g, ""))}
                  placeholder="587"
                  inputMode="numeric"
                />
              </FormField>
            </div>

            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={secure}
                onChange={(e) => setSecure(e.target.checked)}
                className="size-3.5 accent-[var(--color-primary)]"
              />
              Implicit TLS (port 465). Leave off for 587, which upgrades via STARTTLS.
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Username">
                <Input
                  value={form.smtpUser}
                  onChange={(e) => set("smtpUser")(e.target.value)}
                  placeholder="info@illion.tax"
                  autoComplete="off"
                />
              </FormField>
              <FormField
                label={account?.smtpPassSet ? "Password (stored — type to replace)" : "Password"}
              >
                <Input
                  type="password"
                  value={form.smtpPass}
                  onChange={(e) => set("smtpPass")(e.target.value)}
                  placeholder={account?.smtpPassSet ? "••••••••" : ""}
                  autoComplete="new-password"
                />
              </FormField>
            </div>
          </>
        )}

        {account && !account.isDefault && (
          <label className="flex items-center gap-2 border-t border-divider pt-3 text-[13px] text-ink">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="size-3.5 accent-[var(--color-primary)]"
            />
            Active — an inactive mailbox cannot be picked for a send
          </label>
        )}
      </div>
    </Modal>
  );
}

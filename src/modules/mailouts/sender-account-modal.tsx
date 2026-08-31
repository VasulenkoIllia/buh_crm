import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import {
  CONTACT_ORDER,
  MAX_CONTACT_PILLS,
  type ContactField,
  contactsInLetter,
  type MailSenderAccountDto,
} from "@shared/schema/mailouts";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { FormField, Input, Textarea } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { InfoHint } from "@/shared/ui/info-hint";
import { Segmented } from "@/shared/ui/segmented";
import { useCreateSender, useUpdateSender } from "./mailouts.api";
import { encryptionFor, encryptionLabel, secureFor } from "./port-encryption";

/**
 * One mailbox, edited where the detail belongs.
 *
 * All of this used to live on the Sender page itself, which made the page a form for a single
 * mailbox rather than a view of all of them. Here the nine fields are the subject, not the noise.
 */
/** The checks that mean the DELIVERY half needs looking at, so it opens itself when they fire. */
const DELIVERY_FIELDS = new Set([
  "smtpHost",
  "smtpPort",
  "smtpUser",
  "smtpPass",
  "imapHost",
  "imapPort",
  "imapUser",
  "imapPass",
]);

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
    imapHost: "",
    imapPort: "",
    imapUser: "",
    imapPass: "",
    contactEmail: "",
    contactPhone: "",
    contactTelegram: "",
    contactWhatsapp: "",
    contactViber: "",
    contactWebsite: "",
  });
  const [secure, setSecure] = useState(false);
  const [imapSecure, setImapSecure] = useState(true);
  /**
   * Whether bounces from this mailbox are read at all.
   *
   * A switch rather than "leave the host empty", for the reason the transport choice above already
   * learned: a half-filled block reads as configured and behaves as though it were not.
   */
  const [reads, setReads] = useState(false);
  /** Almost every host wants the same credentials for both protocols; asking twice invites a typo. */
  const [imapOwnAuth, setImapOwnAuth] = useState(false);
  /**
   * Whether the delivery half is open.
   *
   * Mail is configured once and then works; what people come back for is the signature and the
   * contact buttons (user, 2026-08-31). So the twelve fields that carry SMTP and IMAP fold into
   * one line — and open themselves for a NEW mailbox, which must be filled, or for one carrying an
   * ERROR, so an incomplete setup can never hide behind a tidy summary.
   *
   * Errors only, not warnings: the two warnings a working mailbox can carry are advice, not faults
   * — "this one borrows the server's account" and "bounces are not read" — and opening twelve
   * fields for advice would defeat the point in the commonest case. Both are visible anyway, in
   * the summary line right beside the arrow.
   */
  const [deliveryOpen, setDeliveryOpen] = useState(false);
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
      imapHost: account?.imapHost ?? "",
      imapPort: account?.imapPort ? String(account.imapPort) : "",
      imapUser: account?.imapUser ?? "",
      imapPass: "",
      contactEmail: account?.contactEmail ?? "",
      contactPhone: account?.contactPhone ?? "",
      contactTelegram: account?.contactTelegram ?? "",
      contactWhatsapp: account?.contactWhatsapp ?? "",
      contactViber: account?.contactViber ?? "",
      contactWebsite: account?.contactWebsite ?? "",
    });
    setSecure(account?.smtpSecure ?? false);
    setImapSecure(account?.imapSecure ?? true);
    setReads(!!account?.imapHost);
    setImapOwnAuth(!!account?.imapUser);
    setTransport(account?.ownSmtp ? "own" : "server");
    setDeliveryOpen(
      !account ||
        account.checks.some(
          (c) => c.level === "error" && !!c.field && DELIVERY_FIELDS.has(c.field),
        ),
    );
    setError(null);
  }, [open, account]);

  /**
   * Whether "server's mailbox vs its own SMTP" is a live question for THIS mailbox: it is for a new
   * one, for one still borrowing the server, and for one being moved back there in this very edit.
   */
  const contactValues = {
    email: form.contactEmail,
    phone: form.contactPhone,
    telegram: form.contactTelegram,
    whatsapp: form.contactWhatsapp,
    viber: form.contactViber,
    website: form.contactWebsite,
  };
  const inLetter = contactsInLetter(contactValues);
  const dropped = CONTACT_ORDER.filter((k) => !!contactValues[k]?.trim() && !inLetter.includes(k));

  const offerTransportChoice = !account || !account.ownSmtp || transport === "server";

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
      // the PORT decides, so a stale tick from a port typed earlier cannot survive the save
      smtpSecure: transport === "own" ? secureFor(form.smtpPort, secure) : null,
      smtpUser: transport === "own" ? form.smtpUser : "",
      // Off clears the whole block, so a mailbox that is not read carries no stale half of one.
      imapHost: reads ? form.imapHost : "",
      imapPort: reads && form.imapPort ? Number(form.imapPort) : null,
      imapSecure: reads ? secureFor(form.imapPort, imapSecure) : null,
      imapUser: reads && imapOwnAuth ? form.imapUser : "",
      // `active` is deliberately ABSENT: the switch lives on the row now, and `accountWrite`
      // writes only what it is given. Sending a value from here would mean editing a signature
      // silently reactivated a mailbox somebody had turned off.
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
      // Same rule for the IMAP one, plus: reusing the SMTP credentials clears any password of its
      // own, so the reader cannot silently keep signing in with a copy nobody remembers setting.
      ...(!reads || !imapOwnAuth
        ? { imapPass: "" }
        : form.imapPass
          ? { imapPass: form.imapPass }
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
            placeholder={
              "Maryna Onyshchenko, EA, MBA\nAccountant | Tax & Accounting Services\n…"
            }
          />
        </FormField>
        <div className="border-t border-divider pt-3">
          <p className="text-[13px] font-semibold">Contact buttons</p>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">
            One button per filled field, in this order. Leave a field empty and its button does
            not appear — nothing is guessed from the signature above.
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
        {/*
          The rule, applied to THIS mailbox rather than described.

          It used to be a footnote — "four fit; the rest are dropped, website first" — which a
          person had to apply to their own six fields to learn that their website button was not
          going out. Now it names the buttons the letter will carry, and the one it will not
          (user, 2026-08-31). `contactsInLetter` is the SERVER's rule, imported, not a second copy.
        */}
        <p className="flex gap-1.5 text-[11px] leading-relaxed text-muted-400">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>
            In the letter:{" "}
            <span className="font-medium text-ink-700">
              {inLetter.length ? inLetter.map((k) => CONTACT_LABELS[k]).join(" · ") : "no buttons"}
            </span>
            {dropped.length > 0 && (
              <>
                {" — "}
                {dropped.map((k) => CONTACT_LABELS[k]).join(" and ")}{" "}
                {dropped.length === 1 ? "does" : "do"} not fit. Only {MAX_CONTACT_PILLS} fit across
                a letter, and the website goes last because the signature already links it.
              </>
            )}
          </span>
        </p>

        <div className="border-t border-divider pt-3">
          <button
            type="button"
            onClick={() => setDeliveryOpen((v) => !v)}
            className="flex w-full items-center gap-2 text-left"
          >
            <span
              className={cn(
                "text-[11px] text-muted transition-transform",
                deliveryOpen && "rotate-90",
              )}
            >
              ▶
            </span>
            <span className="text-[13px] font-semibold">Delivery</span>
            {!deliveryOpen && (
              <span className="truncate font-mono text-[12px] text-muted">
                {deliverySummary({ transport, form, reads, server })}
              </span>
            )}
          </button>
        </div>

        {deliveryOpen && (
        <>
        <p className="text-[13px] font-semibold">Sends over</p>

        {/*
          The choice is offered only where it IS one.

          Borrowing the server's account is a starting state, not a way to run: `bootstrap` creates
          a mailbox on it so a fresh install can send from the first minute, and the app then says
          plainly why to leave — a spam complaint against a mailout damages the very address that
          delivers password resets. A mailbox that already has its own SMTP is never going back,
          so the toggle and its paragraph were four lines of explanation about a road not taken
          (user, 2026-08-31). The way back stays, quietly, underneath.
        */}
        {offerTransportChoice ? (
          <Segmented
            value={transport}
            onChange={(v) => setTransport(v as "server" | "own")}
            options={[
              { value: "server", label: "The server's mailbox" },
              { value: "own", label: "Its own SMTP" },
            ]}
          />
        ) : (
          <button
            type="button"
            onClick={() => setTransport("server")}
            className="self-start text-[12px] text-muted underline decoration-dotted underline-offset-2 hover:text-ink"
          >
            Use the server's mailbox instead
          </button>
        )}

        {transport === "server" ? (
          <div className="rounded-(--radius-field) border border-border bg-surface px-3 py-2.5">
            <p className="font-mono text-[12px] text-ink-700">{server.label}</p>
            {/* reference: what the built-in mailbox IS — read once, then never again */}
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted flex items-center gap-1.5">
              Server mailbox
              <InfoHint label="What the server mailbox is">
                The account that already sends invites and password resets. Nothing to configure, and it works today — which is why a new firm starts here.
              </InfoHint>
            </p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
              It can normally only send as <span className="font-mono">{server.fromEmail}</span>
              . A different From is worth testing before the first real mailout, and once the
              firm sends in volume its own SMTP is safer: a spam complaint here damages the
              address the team needs to sign in.
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

            <Encryption
              port={form.smtpPort}
              checked={secure}
              onChange={setSecure}
            />

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
                label={
                  account?.smtpPassSet ? "Password (stored — type to replace)" : "Password"
                }
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

        <div className="border-t border-divider pt-3">
          <p className="text-[13px] font-semibold">Reading bounces</p>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">
            A server that refuses a letter after taking it says so by email, to this mailbox.
            Left off, those replies are never read and a failed letter goes on reading as sent.
          </p>
        </div>

        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={reads}
            onChange={(e) => setReads(e.target.checked)}
            className="size-3.5 accent-[var(--color-primary)]"
          />
          Read this mailbox for bounces
        </label>

        {reads && (
          <>
            <div className="grid gap-3 sm:grid-cols-[1fr_100px]">
              <FormField label="IMAP host">
                <Input
                  value={form.imapHost}
                  onChange={(e) => set("imapHost")(e.target.value)}
                  placeholder="mail.illion.tax"
                />
              </FormField>
              <FormField label="Port">
                <Input
                  value={form.imapPort}
                  onChange={(e) => set("imapPort")(e.target.value.replace(/\D/g, ""))}
                  placeholder="993"
                  inputMode="numeric"
                />
              </FormField>
            </div>

            <Encryption
              port={form.imapPort}
              checked={imapSecure}
              onChange={setImapSecure}
            />

            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={imapOwnAuth}
                onChange={(e) => setImapOwnAuth(e.target.checked)}
                className="size-3.5 accent-[var(--color-primary)]"
              />
              Sign in with different credentials
            </label>

            {imapOwnAuth ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="Username">
                  <Input
                    value={form.imapUser}
                    onChange={(e) => set("imapUser")(e.target.value)}
                    placeholder="reminder@illion.tax"
                    autoComplete="off"
                  />
                </FormField>
                <FormField
                  label={
                    account?.imapPassSet ? "Password (stored — type to replace)" : "Password"
                  }
                >
                  <Input
                    type="password"
                    value={form.imapPass}
                    onChange={(e) => set("imapPass")(e.target.value)}
                    placeholder={account?.imapPassSet ? "••••••••" : ""}
                    autoComplete="new-password"
                  />
                </FormField>
              </div>
            ) : (
              // reference: it already wore an info icon AND a paragraph; now only the icon
              <p className="flex items-center gap-1.5 text-[11px] text-muted-400">
                Uses the SMTP credentials above
                <InfoHint label="Which credentials IMAP uses">
                  The SMTP username and password above are reused — one mailbox, two protocols, which is what nearly every host expects. Test connection proves it either way.
                </InfoHint>
              </p>
            )}
          </>
        )}
        </>
        )}
      </div>
    </Modal>
  );
}

/**
 * What the port already said, or the question when it said nothing.
 *
 * Two checkboxes stood here, in two near-identical sentences about 465 and 993, and each was a
 * chance to contradict the port right beside it — which produces a connection that hangs rather
 * than an error anyone can read. The four ports mail actually uses answer for themselves; anything
 * else is exactly when a person should be asked (user, 2026-08-31).
 */
function Encryption({
  port,
  checked,
  onChange,
}: {
  port: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const known = encryptionFor(port);
  if (known) {
    return (
      <p className="text-[12px] text-muted">
        Encrypted with <span className="font-medium text-ink">{encryptionLabel(known)}</span>, which
        is what port {port} means.
      </p>
    );
  }
  return (
    <label className="flex items-center gap-2 text-[13px]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-3.5 accent-[var(--color-primary)]"
      />
      Implicit TLS from the first byte (leave off if the port upgrades via STARTTLS)
    </label>
  );
}

/**
 * The delivery half, said in one line.
 *
 * The row above the modal already prints `illion.tax:587 as no-reply@illion.tax`, so twelve
 * editable fields are not what a person needs to SEE — they are what they needed once. This says
 * the same thing in the place the fields used to sit.
 */
function deliverySummary({
  transport,
  form,
  reads,
  server,
}: {
  transport: "server" | "own";
  form: { smtpHost: string; smtpPort: string; imapHost: string; imapPort: string };
  reads: boolean;
  server: { label: string };
}): string {
  const sends =
    transport === "server"
      ? server.label
      : form.smtpHost
        ? `${form.smtpHost}:${form.smtpPort || "?"}`
        : "not set";
  const bounces = reads
    ? form.imapHost
      ? `bounces from ${form.imapHost}:${form.imapPort || "?"}`
      : "bounces on, host not set"
    : "bounces not read";
  return `${sends} · ${bounces}`;
}

/** What each contact field is called where the buttons are listed. */
const CONTACT_LABELS: Record<ContactField, string> = {
  email: "Email",
  phone: "Call",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  viber: "Viber",
  website: "Website",
};

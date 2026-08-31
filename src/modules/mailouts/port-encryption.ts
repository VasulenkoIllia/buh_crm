/** How a mail port is encrypted: implicit TLS from the first byte, or upgraded by STARTTLS. */
export type Encryption = "tls" | "starttls";

/**
 * What the port already tells us, so the form stops asking.
 *
 * These four numbers are not a convention someone might follow — they are what the ports MEAN, and
 * a server answering 587 with implicit TLS or 993 with STARTTLS is not a setup anyone has. Two
 * checkboxes asked the question anyway, in two near-identical sentences, and getting either wrong
 * produces a connection that hangs rather than an error that explains itself (user, 2026-08-31).
 *
 * `null` for anything else — an unusual port is exactly when a person should be asked rather than
 * guessed at, so the control comes back.
 */
export function encryptionFor(port: string | number | null | undefined): Encryption | null {
  const n = typeof port === "string" ? Number(port) : port;
  switch (n) {
    case 465: // SMTPS
    case 993: // IMAPS
      return "tls";
    case 587: // SMTP submission
    case 143: // IMAP
      return "starttls";
    default:
      return null;
  }
}

/** What the field shows beside the port. */
export function encryptionLabel(e: Encryption): string {
  return e === "tls" ? "TLS" : "STARTTLS";
}

/**
 * The value the API wants: `smtpSecure` / `imapSecure` mean "implicit TLS".
 * A known port answers for itself; anything else keeps whatever the person chose.
 */
export function secureFor(port: string | number | null | undefined, chosen: boolean): boolean {
  const e = encryptionFor(port);
  return e ? e === "tls" : chosen;
}

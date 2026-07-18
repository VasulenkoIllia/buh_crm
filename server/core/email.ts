import nodemailer, { type Transporter } from "nodemailer";
import { config, isDev } from "./config.js";

// Shared SMTP transport (Nodemailer → Mailpit in dev). Modules never touch SMTP
// directly — they call sendEmail(template, to, data). Treated as an unreliable
// boundary: retried, never blocks the request path (callers fire-and-forget).

export interface EmailTemplates {
  invite: { inviteUrl: string; invitedBy: string };
  passwordReset: { resetUrl: string };
}

export type EmailTemplateName = keyof EmailTemplates;

/** The web origin used in email links (dev = Vite, prod = the real domain). */
export function webOrigin(): string {
  return isDev ? "http://localhost:5173" : `https://${config.APP_DOMAIN}`;
}

function render<T extends EmailTemplateName>(
  template: T,
  data: EmailTemplates[T],
): { subject: string; html: string } {
  switch (template) {
    case "invite": {
      const d = data as EmailTemplates["invite"];
      return {
        subject: `You are invited to ${config.APP_NAME}`,
        html: [
          `<p>${d.invitedBy} invited you to the ${config.APP_NAME} CRM.</p>`,
          `<p><a href="${d.inviteUrl}">Set your password</a> to activate your account.</p>`,
          `<p>The link expires in 7 days.</p>`,
        ].join("\n"),
      };
    }
    case "passwordReset": {
      const d = data as EmailTemplates["passwordReset"];
      return {
        subject: `Reset your ${config.APP_NAME} password`,
        html: [
          `<p>Someone requested a password reset for your account.</p>`,
          `<p><a href="${d.resetUrl}">Set a new password</a> (the link expires in 1 hour).</p>`,
          `<p>If it wasn't you, ignore this email.</p>`,
        ].join("\n"),
      };
    }
  }
  throw new Error(`Unknown email template: ${template}`);
}

/** Test outbox — in NODE_ENV=test emails are collected here instead of sent. */
export const testOutbox: Array<{ to: string; subject: string; html: string }> = [];

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  transporter ??= nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
    // fail fast instead of hanging on an unreachable host
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transporter;
}

const MAX_ATTEMPTS = 3;

export async function sendEmail<T extends EmailTemplateName>(
  template: T,
  to: string,
  data: EmailTemplates[T],
): Promise<void> {
  const { subject, html } = render(template, data);

  if (config.NODE_ENV === "test") {
    testOutbox.push({ to, subject, html });
    return;
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await getTransporter().sendMail({ from: config.MAIL_FROM, to, subject, html });
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, attempt * 500));
    }
  }
  // never swallow silently — a broken SMTP config must be visible in the server logs
  console.error(
    `[email] send failed after ${MAX_ATTEMPTS} attempts — template=${template} to=${to}:`,
    lastError,
  );
  throw lastError;
}

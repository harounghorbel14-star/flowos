import { createTransport } from "nodemailer";
import { env } from "../env";

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text only: nothing user-controlled is ever rendered as HTML. */
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** SMTP delivery. The URL carries credentials: it is never logged or returned. */
export function smtpMailer(url: string, from: string): Mailer {
  const transport = createTransport(
    { url, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 },
    { from },
  );
  return {
    async send(message) {
      await transport.sendMail({ from, to: message.to, subject: message.subject, text: message.text });
    },
  };
}

let override: Mailer | null | undefined;
let configured: Mailer | null | undefined;

/** The configured mailer, or null when outgoing email is not set up (SMTP_URL and MAIL_FROM). */
export function getMailer(): Mailer | null {
  if (override !== undefined) return override;
  if (configured === undefined) {
    const { SMTP_URL, MAIL_FROM } = env();
    configured = SMTP_URL && MAIL_FROM ? smtpMailer(SMTP_URL, MAIL_FROM) : null;
  }
  return configured;
}

/** Tests: a capturing mailer, null for "email not configured", undefined to restore. */
export function setMailerForTests(mailer: Mailer | null | undefined): void {
  override = mailer;
}

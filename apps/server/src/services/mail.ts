import nodemailer, { type Transporter } from 'nodemailer';
import type { Config } from '../config.ts';

let cached: { url: string; t: Transporter } | null = null;

/** Send an email if SMTP is configured. Returns false when email is not set up or sending failed. */
export async function sendMail(cfg: Config, to: string, subject: string, text: string): Promise<boolean> {
  if (!cfg.smtpUrl) return false;
  if (!cached || cached.url !== cfg.smtpUrl)
    cached = { url: cfg.smtpUrl, t: nodemailer.createTransport(cfg.smtpUrl) };
  try {
    await cached.t.sendMail({ from: cfg.mailFrom, to, subject, text });
    return true;
  } catch (e) {
    console.error('Email failed:', (e as Error).message);
    return false;
  }
}

/** Test hook: capture emails instead of sending. */
export const outbox: { to: string; subject: string; text: string }[] = [];
export function useTestTransport() {
  cached = {
    url: 'test://',
    t: {
      sendMail: async (m: { to: string; subject: string; text: string }) => void outbox.push(m),
    } as unknown as Transporter,
  };
}

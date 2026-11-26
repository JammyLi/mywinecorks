/** Portal emails (zh-TW / en), recorded in the emails table; sent by SMTP when configured. */
import nodemailer from 'nodemailer';
import type { PortalConfig } from './config.ts';
import type { Sql } from './db.ts';

type Lang = 'zh-TW' | 'en';
const T: Record<string, Record<Lang, (v: Record<string, string>) => { subject: string; body: string }>> = {
  invite: {
    'zh-TW': (v) => ({
      subject: `${v.shop} 邀請您使用專屬選酒頁`,
      body: `${v.name} 您好：\n\n${v.shop} 邀請您使用專屬的選酒頁面。請用這個連結設定密碼（14 天內有效，只能使用一次）：\n${v.link}\n\n您需年滿 ${v.age} 歲。`,
    }),
    en: (v) => ({
      subject: `${v.shop} invites you to its private wine list`,
      body: `Hello ${v.name},\n\n${v.shop} has invited you to its private wine list. Set your password with this link (valid 14 days, works once):\n${v.link}\n\nYou must be ${v.age} or older.`,
    }),
  },
  available: {
    'zh-TW': (v) => ({
      subject: `${v.wine} 現在可以訂購`,
      body: `${v.name} 您好：\n\n您關注的 ${v.wine} 現在可以向 ${v.shop} 訂購：\n${v.link}\n`,
    }),
    en: (v) => ({
      subject: `${v.wine} is available`,
      body: `Hello ${v.name},\n\n${v.wine}, which you asked about, can now be requested from ${v.shop}:\n${v.link}\n`,
    }),
  },
};

export async function sendMail(
  cfg: PortalConfig,
  sql: Sql,
  to: string,
  lang: string,
  kind: keyof typeof T,
  vars: Record<string, string>,
) {
  const m = T[kind][lang === 'en' ? 'en' : 'zh-TW'](vars);
  const row = (await sql.one<{ id: number }>(
    'INSERT INTO emails (to_addr, subject, body) VALUES ($1,$2,$3) RETURNING id',
    [to, m.subject, m.body],
  ))!;
  if (!cfg.smtpUrl) return false;
  try {
    await nodemailer
      .createTransport(cfg.smtpUrl)
      .sendMail({ from: cfg.mailFrom, to, subject: m.subject, text: m.body });
    await sql.q('UPDATE emails SET sent_at = now() WHERE id = $1', [row.id]);
    return true;
  } catch (e) {
    await sql.q('UPDATE emails SET error = $2 WHERE id = $1', [row.id, (e as Error).message]);
    return false;
  }
}

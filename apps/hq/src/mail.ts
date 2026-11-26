/** HQ emails (SPEC §21.1): zh/en templates; kept in the emails table, sent by SMTP when configured. */
import nodemailer from 'nodemailer';
import type { HqConfig } from './config.ts';
import type { Sql } from './db.ts';

type Lang = 'zh-TW' | 'en';
const T: Record<string, Record<Lang, (v: Record<string, string>) => { subject: string; body: string }>> = {
  licenseIssued: {
    'zh-TW': (v) => ({
      subject: `MyWineCorks 授權金鑰（${v.client}）`,
      body: `${v.name} 您好：\n\n這是您的 MyWineCorks 授權金鑰，方案「${v.plan}」，有效至 ${v.expires}。\n\n請以擁有者身分登入，到「設定 › 授權」貼上金鑰或上傳附件的授權檔：\n\n${v.key}\n\n有任何問題請回覆這封信。\nMyWineCorks`,
    }),
    en: (v) => ({
      subject: `Your MyWineCorks license (${v.client})`,
      body: `Hello ${v.name},\n\nHere is your MyWineCorks license key — plan "${v.plan}", valid until ${v.expires}.\n\nSign in as the Owner and paste it in Settings › License, or upload the license file:\n\n${v.key}\n\nReply to this email if you need help.\nMyWineCorks`,
    }),
  },
  renewalReminder: {
    'zh-TW': (v) => ({
      subject: `MyWineCorks 授權將在 ${v.days} 天後到期`,
      body: `${v.name} 您好：\n\n${v.client} 的 MyWineCorks 授權將於 ${v.expires} 到期。到期後有 14 天寬限期，之後系統會鎖定（資料不會刪除，擁有者仍可匯出）。\n\n請與我們聯絡續約。\nMyWineCorks`,
    }),
    en: (v) => ({
      subject: `Your MyWineCorks license expires in ${v.days} days`,
      body: `Hello ${v.name},\n\nThe MyWineCorks license for ${v.client} expires on ${v.expires}. After a 14-day grace period the app locks (no data is deleted and the Owner can still export).\n\nPlease contact us to renew.\nMyWineCorks`,
    }),
  },
  setupLink: {
    'zh-TW': (v) => ({
      subject: 'MyWineCorks HQ 帳號設定',
      body: `您好：\n\n請用這個連結設定 MyWineCorks HQ 的密碼與兩步驟驗證（7 天內有效）：\n${v.link}\n`,
    }),
    en: (v) => ({
      subject: 'Your MyWineCorks HQ account',
      body: `Hello,\n\nSet your MyWineCorks HQ password and 2-step verification with this link (valid 7 days):\n${v.link}\n`,
    }),
  },
};

export async function sendMail(
  cfg: HqConfig,
  sql: Sql,
  kind: keyof typeof T,
  to: string,
  lang: string,
  vars: Record<string, string>,
  ref?: string,
) {
  if (!to) return false;
  const m = T[kind][lang === 'en' ? 'en' : 'zh-TW'](vars);
  const row = await sql.one<{ id: number }>(
    `INSERT INTO emails (to_addr, subject, body, kind, ref) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
    [to, m.subject, m.body, kind, ref ?? null],
  );
  if (!row) return false; // this reminder was already sent
  if (!cfg.smtpUrl) return true;
  try {
    await nodemailer
      .createTransport(cfg.smtpUrl)
      .sendMail({ from: cfg.mailFrom, to, subject: m.subject, text: m.body });
    await sql.q('UPDATE emails SET sent_at = now() WHERE id = $1', [row.id]);
  } catch (e) {
    await sql.q('UPDATE emails SET error = $2 WHERE id = $1', [row.id, (e as Error).message]);
  }
  return true;
}

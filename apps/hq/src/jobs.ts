/** Renewal reminders to clients: 30 / 14 / 7 / 1 days before a license expires (once each). */
import type { HqConfig } from './config.ts';
import type { Sql } from './db.ts';
import { sendMail } from './mail.ts';

export const REMINDER_DAYS = [30, 14, 7, 1];

export async function sendRenewalReminders(cfg: HqConfig, sql: Sql, now = new Date()) {
  const rows = await sql.q<{
    id: number;
    lid: string;
    expires_at: Date;
    email: string | null;
    lang: string;
    name: string;
    contact_name: string | null;
  }>(
    `SELECT l.id, l.lid, l.expires_at, c.email, c.lang, c.name, c.contact_name FROM licenses l JOIN clients c ON c.id = l.client_id
     WHERE l.status = 'active' AND c.status <> 'cancelled' AND l.expires_at > $1 AND l.expires_at <= $1::timestamptz + interval '31 days'`,
    [now.toISOString()],
  );
  let sent = 0;
  for (const r of rows) {
    if (!r.email) continue;
    const exp = new Date(r.expires_at);
    const days = Math.ceil((exp.getTime() - now.getTime()) / 86400_000);
    const step = REMINDER_DAYS.filter((d) => days <= d).at(-1);
    if (step == null) continue;
    const expires = exp.toISOString().slice(0, 10);
    // ref includes the expiry, so a renewed license gets its own reminders.
    if (
      await sendMail(
        cfg,
        sql,
        'renewalReminder',
        r.email,
        r.lang,
        { name: r.contact_name || r.name, client: r.name, expires, days: String(days) },
        `${r.lid}:${expires}:${step}`,
      )
    )
      sent++;
  }
  return sent;
}

export function startJobs(cfg: HqConfig, sql: Sql) {
  const run = () => sendRenewalReminders(cfg, sql).catch((e) => console.error('reminders:', e));
  const t1 = setTimeout(run, 10_000);
  const t2 = setInterval(run, 6 * 3600_000);
  t1.unref();
  t2.unref();
  return () => (clearTimeout(t1), clearInterval(t2));
}

# Development backlog

Work for Claude that is agreed but not yet built. Items move to `CHANGELOG.md` when done.
(Things only Jammy can do are in `TODO-JAMMY.md`.)

## B1 — Backup to a file or folder, and restore from it (asked 27 Nov 2026)

**Already in 1.0.0-beta.1** (Settings › Updates & backups, Owner only):
- Automatic daily backup on the server, last 7 kept, plus a backup before every update and restore.
- "Back up now".
- A second copy of every backup (with photos) to a folder you choose, such as a NAS or USB drive.
- Restore from one of those backups, after a check, by typing the confirmation word and the
  Owner password. A safety backup is taken first.

**To build:**
1. **Backup to a file.** "Download backup" gives one file (e.g. `MyWineCorks-my-cellar-20261127.mwcbackup`)
   with the database and photos, which you can keep anywhere. It works on cloud workspaces too,
   where there is no folder to copy to.
2. **Automatic backup to a folder: settings.** How often (daily, or every N hours), what time, how many
   to keep in the folder, and photos on or off. Shows the last success, and a warning in the app and an
   email to the Owner when copying fails for 2 days.
3. **Restore from a file or folder.** Choose a `.mwcbackup` file, or a backup in the copy folder, as well
   as the server's own list. Same safety steps: check the file is genuine, from this workspace and not
   from a newer version; type the confirmation word and the Owner password; take a safety backup first.
   Write it to the change log.
4. **Restore onto a new computer.** On a fresh install, the first-run screen offers "Restore from a
   backup" next to "Create company", so a lost PC can be replaced without copying files by hand.
5. **Space limits.** Today each kind is capped (daily 7, manual 5, before-update 5, before-restore 5), the
   copy folder holds the same set, and photos are mirrored once rather than in every backup. Add: the
   number to keep per kind as a setting, a total size shown on the page, and removal of photos from the
   mirror 30 days after they are deleted in the app (today they stay there).
6. **Optional: encryption.** A password on the backup file, so a lost USB drive does not expose prices
   and customers. Without the password the file cannot be restored, so it must be kept safe.
7. Permissions: Owner only (decision 17). Tests for each restore check. Manual chapter "Running your own
   server" updated in both languages.

## B2 — Shrink photos on upload (found 27 Nov 2026 while costing the cloud)

Wine photos are stored exactly as the phone takes them (often 3–5 MB, up to 15 MB). Resize in the
browser before upload to about 1600 px on the long side, JPEG ≈ 80 % (≈ 200–400 KB), and keep a small
thumbnail (≈ 400 px) for lists and the portal. About 90 % less disk and backup space, and faster pages
on phones and in the portal. A one-time tool shrinks photos already stored (with a backup first).

## B3 — Support centre with video lessons (asked 27 Nov 2026)

A support page on MyWineCorks.com behind the client sign-in (the existing Client account, one-time email
link). It has short screen-recorded videos for every function, in zh-TW and en (or zh with subtitles):
first sign-in, storage and labels, stock-in, finding wine, moving and stocktake, the phone app, orders,
customer portal and catalogs, AI, users and roles, import, backups and restore, updates.
- Each video sits next to its manual chapter and has a search box; it is grouped by plan, so a Collector
  does not see merchant topics.
- Hosting: private videos (e.g. Cloudflare Stream or Vimeo with domain lock), or files served only to
  signed-in clients. Not public on YouTube.
- Also on the page: "Contact support" (goes to HQ › Website requests as a support ticket), release
  notes, and the status of their license.
- Jammy records the videos (or Claude writes the scripts and shot list first, then Jammy records).

## B4 — AI: our add-on, or the client's own Claude API key (asked 27 Nov 2026)

Two ways to switch on AI, chosen per license in HQ:
1. **MyWineCorks AI (add-on):** as now, through our gateway, with a monthly allowance, billed by us.
2. **Bring your own key:** the client pastes their own Claude API key (Owner only, Settings › AI). They pay
   Anthropic directly; there is no allowance from us and no AI add-on price.
- The key is stored encrypted, is never shown again after it is saved, and is never sent to phones, the
  portal or exports. A "Test key" button checks it. It is written to the change log as "AI key changed",
  without the key itself.
- The requests still go through the gateway, so the prompts, label rules and usage display stay the same.
  The gateway uses the client's key for that license and does not count it against our cap.
- Decision for Jammy: does bring-your-own-key need the AI module in the plan (a small fee), or is it free?

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
5. **Optional: encryption.** A password on the backup file, so a lost USB drive does not expose prices
   and customers. Without the password the file cannot be restored, so it must be kept safe.
6. Permissions: Owner only (decision 17). Tests for each restore check. Manual chapter "Running your own
   server" updated in both languages.

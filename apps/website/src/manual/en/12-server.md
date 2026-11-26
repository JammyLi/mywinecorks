---
title: Running your own server
summary: Installing, updates, backups, restoring and the licence.
---
## Installing

**Windows (10 or 11):** download the installer from the client account on this website and run it on a PC that stays on. It installs MyWineCorks as a Windows service, opens the firewall for your local network only, and opens a one-time link to create your company and the Owner account. In **Settings › License**, upload your licence file.

**Mac, Linux, NAS:** use the Docker package from the client account (`docker compose up -d`); the first-run link is in `first-run.txt` in the data folder (and in the log).

People in the office open `http://<server>:3500`. Phones use the secure address shown on **Phone setup**.

## Updates

**Settings › Updates & backups** shows your version and any update. **Update now** downloads it (checked against our signature), backs everything up and restarts. If the new version does not start, the previous one comes back by itself.

## Backups

MyWineCorks backs up every database **every day** (kept for 7 days), before each update and whenever you click **Back up now**. These copies are on the server's own disk — so also set a **second copy on another disk**: a NAS, a USB drive or a network share. Every backup and the wine photos are then copied there too. Check now and then that the "last copied" date is recent.

## Restoring

In **Settings › Updates & backups**, choose a backup and **Restore…**. You see what it holds, type the confirmation word and your password. Everything changed after that backup is replaced, but a backup of how things are right now is taken first, so a restore can be undone. Numbers already given to bottles and cases after the backup are not given out again.

If the server itself is lost: install MyWineCorks on the new PC, stop the service, copy the newest backup's `tenants/<workspace>/app.db` from the second copy into `C:\ProgramData\MyWineCorks\tenants\<workspace>\` (replacing the empty one), start the service, and ask us to move the licence.

## The licence

The server checks its licence with us once a day (only the licence, installation, version and three counts are sent). Without a check it keeps working for 7 days, then warns; after 30 days it locks until it can check again. Moving to a new PC: ask us to move the licence (up to twice a year).

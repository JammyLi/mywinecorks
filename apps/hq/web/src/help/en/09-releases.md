# Releases and downloads

## Releases

Self-hosted servers ask HQ for updates at their daily check-in. Under **Releases**:

1. Press **New release**: version number (e.g. 1.0.1), **Channel** (**Stable** is offered to all servers; **Beta** is kept for testing and not offered automatically), release date and notes in 中文 and English — clients see these notes before they update.
2. **Minimum version** — set it only when older versions must update (for example a security fix); older servers are then told to update.
3. The update packages themselves are added by the developer with `pnpm --filter @mwc/hq publish-release`. Servers see them at their next check-in; the Owner installs the update in **Settings › Updates & backups**.

## Downloads for clients

**Downloads for clients** lists the files offered in the client account on the website: the **Windows installer**, **Docker (Mac / Linux / NAS)** and **Guides**. The newest active file of each kind is offered. Use **Hide** to stop offering a file (e.g. one with a problem) and **Show** to offer it again. New files are added by the developer with `pnpm --filter @mwc/hq publish-download`.

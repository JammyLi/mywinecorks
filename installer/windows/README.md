# Windows installer

```bash
installer/windows/build.sh --trust installer/keys/hq-license-public.pem
# → release/MyWineCorks-Setup-<version>.exe  and  release/win-x64/MyWineCorks-<version>-win-x64.tar.gz (update package)
```
Needs Node 22, pnpm, `makensis` (`brew install makensis` / `apt install nsis`) and internet (npm, GitHub).
The installer contains Node 22 for Windows, the bundled server, the pages and WinSW; the client's
computer needs nothing else. CI builds it and tests a clean install, an upgrade and an uninstall on
Windows (`.github/workflows/release.yml`).

| | |
|---|---|
| Program | `C:\Program Files\MyWineCorks` (launcher + the installed version) |
| Data | `C:\ProgramData\MyWineCorks` — databases, photos, certificates, backups, in-app updates, logs; Administrators and the service only |
| Service | "MyWineCorks", automatic start, restarts 10 s after a crash, no sign-in needed |
| Firewall | TCP 3500 (browsers) and 5543 (phones, HTTPS) — same network only |
| Shortcuts | Desktop "MyWineCorks"; Start menu: MyWineCorks, Phone setup, Addresses, Data and backups folder, Uninstall |

- **New install:** the browser opens a one-time setup link (`first-run.txt` in the data folder): company
  and Owner, then the Owner sets a password. There is no default password.
- **Upgrade:** run the new installer, or press "Update now" in Settings › Updates & backups. Data is
  backed up first; a failed new version goes back to the previous one by itself.
- **Uninstall:** keeps the data.
- Not code-signed yet: Windows SmartScreen shows "Windows protected your PC" → More info → Run anyway.
  Signing needs the code-signing certificate (BUILD-PLAN decision 5).
- Silent install for IT: `MyWineCorks-Setup-<version>.exe /S`.

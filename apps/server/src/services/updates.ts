/**
 * In-app updates for self-hosted servers (SPEC §10.2): HQ tells the server about new versions at
 * check-in; the Owner presses "Update"; the server downloads the package for its platform from HQ
 * (only with a valid, bound license — SPEC §20.1), checks HQ's signature and checksum, backs up
 * every database, unpacks the new version next to the old one and restarts into it through the
 * launcher. If the new version does not start, the launcher goes back to the previous one.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { APP_VERSION } from '@mwc/shared';
import type { Config } from '../config.ts';
import { ApiError, badRequest } from '../errors.ts';
import type { Licensing } from './licensing.ts';
import { backupAll } from './maintenance.ts';

export interface Manifest {
  version: string;
  platform: string;
  sha256: string;
  size: number;
  signature: string;
  notesZh: string;
  notesEn: string;
  releasedOn: string;
}

/** What HQ signs for every package; the server checks it with the embedded HQ key. */
export const updateSigningText = (m: Pick<Manifest, 'version' | 'platform' | 'sha256' | 'size'>) =>
  `MWC-UPDATE\n${m.version}\n${m.platform}\n${m.sha256}\n${m.size}`;

export function cmpVersion(a: string, b: string) {
  const pa = a.split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export function verifyManifest(m: Manifest, keys: string[]) {
  const data = Buffer.from(updateSigningText(m));
  const sig = Buffer.from(m.signature, 'base64url');
  return keys.some((k) => {
    try {
      return crypto.verify(null, data, k, sig);
    } catch {
      return false;
    }
  });
}

/** Where updates live: <data>/app/<version>/ and <data>/app/current.json (read by the launcher). */
export const appDir = (cfg: Config) => path.join(cfg.dataDir, 'app');

export class Updater {
  /** For tests. */
  fetcher: typeof fetch = (...a) => fetch(...a);
  /** For tests: what happens after a successful install (default: exit 75, the launcher restarts). */
  restart: () => void = () => setTimeout(() => process.exit(75), 1500).unref();
  busy = false;

  constructor(
    private cfg: Config,
    private licensing: Licensing,
  ) {}

  canInstall() {
    return this.cfg.mode === 'selfhost' && this.cfg.launched;
  }

  private body(extra: object = {}) {
    const id = this.licensing.identity();
    if (!id.licenseId) throw badRequest('updateNeedsLicense');
    return { ...id, platform: this.cfg.platform, version: APP_VERSION, ...extra };
  }

  /** Ask HQ for the newest package for this platform (null = up to date). */
  async check(): Promise<Manifest | null> {
    const r = await this.licensing.call('/api/updates/manifest', this.body());
    if (!r.ok) throw new ApiError(502, r.body.error ?? 'hqError');
    const m = (r.body as unknown as { manifest: Manifest | null }).manifest;
    if (!m) return null;
    if (!verifyManifest(m, this.licensing.keys)) throw badRequest('updateSignature');
    if (m.platform !== this.cfg.platform || cmpVersion(m.version, APP_VERSION) <= 0) return null;
    return m;
  }

  /** Download, verify, back up, unpack, switch. Returns the new version and the backup folder. */
  async install(): Promise<{ version: string; backup: string | null }> {
    if (!this.canInstall()) throw badRequest('updateNotHere');
    if (this.busy) throw new ApiError(409, 'updateRunning');
    this.busy = true;
    try {
      const m = await this.check();
      if (!m) throw badRequest('upToDate');
      const root = appDir(this.cfg);
      fs.mkdirSync(root, { recursive: true });
      const tmp = path.join(root, `download-${m.version}.tar.gz`);
      let res: Response;
      try {
        res = await this.fetcher(this.cfg.hqUrl + '/api/updates/download', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(this.body({ want: m.version })),
          signal: AbortSignal.timeout(15 * 60_000),
        });
      } catch {
        throw new ApiError(502, 'hqUnreachable');
      }
      if (!res.ok || !res.body) throw new ApiError(502, 'updateDownloadFailed');
      await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp));
      const sum = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
      if (sum !== m.sha256 || fs.statSync(tmp).size !== m.size) {
        fs.rmSync(tmp, { force: true });
        throw badRequest('updateChecksum');
      }
      // Everything is backed up before the new version can touch a database.
      const backup = backupAll(this.cfg.dataDir, `pre-update-${APP_VERSION}-to-${m.version}`);
      const dest = path.join(root, m.version);
      const staging = dest + '.new';
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });
      // tar is built into Windows 10+, macOS and Linux.
      execFileSync('tar', ['-xzf', tmp, '-C', staging], { stdio: 'ignore' });
      if (!fs.existsSync(path.join(staging, 'server.mjs'))) throw badRequest('updateBadPackage');
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(staging, dest);
      fs.rmSync(tmp, { force: true });
      const curFile = path.join(root, 'current.json');
      let previous: string | null = null;
      try {
        previous = (JSON.parse(fs.readFileSync(curFile, 'utf8')) as { version: string }).version;
      } catch {
        /* first update: the launcher falls back to the installed version */
      }
      fs.writeFileSync(
        curFile,
        JSON.stringify({ version: m.version, previous, tries: 0, at: new Date().toISOString() }, null, 2),
      );
      this.restart();
      return { version: m.version, backup };
    } finally {
      this.busy = false;
    }
  }
}

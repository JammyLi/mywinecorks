/**
 * First start of a new self-hosted server (installer / Docker): no workspace yet and no default
 * password. The server writes a one-time link to <data>/first-run.txt (and the log); the installer
 * opens it on the server computer. The link creates the workspace and its Owner, then continues
 * with the normal Owner setup link (password + optional 2-step verification).
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.ts';
import type { Registry } from '../db/registry.ts';
import { Api, PUBLIC } from '../http.ts';
import { badRequest, conflict } from '../errors.ts';
import { newToken, sha256 } from '../services/crypto.ts';
import { createWorkspace, setupUrl } from '../services/workspace.ts';

const file = (cfg: Config) => path.join(cfg.dataDir, 'first-run.txt');
const needed = (cfg: Config, registry: Registry) => cfg.mode === 'selfhost' && registry.list().length === 0;

/** At start-up: make sure a fresh server has a first-run link. Returns it (or null). */
export function ensureFirstRun(cfg: Config, registry: Registry): string | null {
  registry.db.exec(
    'CREATE TABLE IF NOT EXISTS first_run (id INTEGER PRIMARY KEY CHECK (id = 1), token_hash TEXT NOT NULL, created_at TEXT NOT NULL)',
  );
  if (!needed(cfg, registry)) {
    registry.db.exec('DELETE FROM first_run');
    fs.rmSync(file(cfg), { force: true });
    return null;
  }
  // A new token on every start: only whoever can read the server's data folder (or its log) gets it.
  const token = newToken(24);
  registry.db
    .prepare('INSERT OR REPLACE INTO first_run (id, token_hash, created_at) VALUES (1, ?, ?)')
    .run(sha256(token), new Date().toISOString());
  const url = `${cfg.publicUrl}/welcome?t=${encodeURIComponent(token)}`;
  fs.writeFileSync(file(cfg), url + '\n', { mode: 0o600 });
  return url;
}

const valid = (registry: Registry, t: string) => {
  const r = registry.db.prepare('SELECT token_hash FROM first_run WHERE id = 1').get() as
    { token_hash: string } | undefined;
  return !!r && !!t && r.token_hash === sha256(t);
};

const slugOf = (name: string) =>
  name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'cellar';

export function mountFirstRun(api: Api) {
  /** The sign-in page asks this: a new server shows "finish setting up on the server computer". */
  api.get('/public/first-run', PUBLIC, (req) => {
    const { cfg, registry } = req.ctx;
    const t = String(req.query.t ?? '');
    return { needed: needed(cfg, registry), valid: needed(cfg, registry) && valid(registry, t) };
  });

  api.post('/public/first-run', PUBLIC, (req) => {
    const { cfg, registry } = req.ctx;
    const b = z
      .object({
        t: z.string(),
        company: z.string().trim().min(1).max(200),
        ownerEmail: z.string().trim().toLowerCase().email(),
        ownerName: z.string().trim().max(100).default(''),
        lang: z.enum(['zh-TW', 'en']).default('zh-TW'),
      })
      .parse(req.body);
    if (!needed(cfg, registry)) throw conflict('alreadySetUp');
    if (!valid(registry, b.t)) throw badRequest('firstRunLinkInvalid');
    const slug = slugOf(b.company);
    const { token } = createWorkspace(registry, {
      slug,
      name: b.company,
      ownerEmail: b.ownerEmail,
      ownerName: b.ownerName,
      lang: b.lang,
    });
    registry.db.exec('DELETE FROM first_run');
    fs.rmSync(file(cfg), { force: true });
    // Continue on the same server address the browser used (the setup link is relative).
    return { setup: new URL(setupUrl(cfg.publicUrl, slug, token)).search.replace(/^/, '/setup') };
  });
}

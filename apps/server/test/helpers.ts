import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { createApp } from '../src/app.ts';
import { loadConfig, type Mode } from '../src/config.ts';
import { createWorkspace } from '../src/services/workspace.ts';

export const PW = 'correct-horse-9';

export function makeServer(mode: Mode = 'selfhost', extra: Record<string, string> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwc-test-'));
  const cfg = loadConfig({ MODE: mode, DATA_DIR: dataDir, PUBLIC_URL: 'http://localhost:5500', ...extra });
  const { app, api, registry, licensing, updater, portal, ai } = createApp(cfg);
  const ws = createWorkspace(registry, {
    slug: 'demo',
    name: 'Demo Cellar',
    lang: 'en',
    ownerEmail: 'owner@example.com',
    ownerName: 'Olivia',
    currency: 'TWD',
  });
  const cleanup = () => {
    registry.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return {
    app,
    api,
    registry,
    licensing,
    updater,
    portal,
    ai,
    cfg,
    db: ws.db,
    ownerToken: ws.token,
    cleanup,
  };
}

export type Server = ReturnType<typeof makeServer>;

export const tokenFrom = (url: string) => new URL(url).searchParams.get('t')!;

/** Complete a setup link and return a signed-in agent. */
export async function setupAndLogin(
  s: Server,
  token: string,
  email: string,
  password = PW,
): Promise<TestAgent> {
  await request(s.app).post('/api/auth/setup').send({ workspace: 'demo', token, password }).expect(200);
  const agent = request.agent(s.app);
  await agent.post('/api/auth/login').send({ workspace: 'demo', email, password }).expect(200);
  return agent;
}

/** Create a user with the given role (as owner) and return their signed-in agent. */
export async function userWithRole(
  s: Server,
  owner: TestAgent,
  roleId: number,
  email: string,
): Promise<TestAgent> {
  const r = await owner
    .post('/api/users')
    .send({ email, name: email.split('@')[0], roleId })
    .expect(200);
  return setupAndLogin(s, tokenFrom(r.body.setupUrl), email);
}

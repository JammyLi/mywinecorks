import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DICTS } from '@mwc/ui';

const src = path.resolve(import.meta.dirname, '../src');
const files = (d: string): string[] =>
  fs
    .readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]));
const code = files(src)
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n');

describe('server strings have zh-TW and en labels', () => {
  it('every change-log action', () => {
    const actions = new Set(
      [...code.matchAll(/action: (?:lock \? )?'(\w+)'(?: : '(\w+)')?/g)]
        .flatMap((m) => [m[1], m[2]])
        .filter(Boolean),
    );
    expect(actions.size).toBeGreaterThan(10);
    for (const a of actions)
      for (const d of Object.values(DICTS))
        expect((d as Record<string, string>)[`audit.act.${a}`], a).toBeTruthy();
  });
  it('every error code', () => {
    const codes = new Set(
      [...code.matchAll(/(?:badRequest|unauthorized|forbidden|notFound|conflict)\('(\w+)'/g)].map(
        (m) => m[1],
      ),
    );
    for (const c of codes)
      for (const d of Object.values(DICTS)) expect((d as Record<string, string>)[`err.${c}`], c).toBeTruthy();
  });
});

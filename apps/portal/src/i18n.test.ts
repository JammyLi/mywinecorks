import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PORTAL_DICTS } from './i18n.ts';

const read = (d: string): string =>
  fs
    .readdirSync(d, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? [read(path.join(d, e.name))]
        : /\.tsx?$/.test(e.name) && !e.name.includes('.test.')
          ? [fs.readFileSync(path.join(d, e.name), 'utf8')]
          : [],
    )
    .join('\n');
const has = (k: string) => Object.values(PORTAL_DICTS).every((d) => k in d);

describe('portal strings have zh-TW and en', () => {
  it('same keys', () =>
    expect(Object.keys(PORTAL_DICTS['zh-TW']).sort()).toEqual(Object.keys(PORTAL_DICTS.en).sort()));
  it("every t('key') in the portal", () => {
    const code = read(import.meta.dirname);
    const keys = [...code.matchAll(/\bt\(\s*'([\w.]+)'/g)].map((m) => m[1]);
    expect(keys.filter((k) => !has(k))).toEqual([]);
  });
  it('every error the portal service sends to customers', () => {
    const svc = read(path.resolve(import.meta.dirname, '../../portal-service/src/routes'));
    const codes = [...svc.matchAll(/(?:bad|PError\(\d+,)\s*\(?'(\w+)'/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(5);
    expect(
      codes.filter(
        (c) =>
          !has(`err.${c}`) &&
          ![
            'badRequest',
            'badSignature',
            'unknownClient',
            'staleSnapshot',
            'photoChecksum',
            'photoTooLarge',
            'customerNotSynced',
            'badHandle',
            'badKey',
            'notFound',
          ].includes(c),
      ),
    ).toEqual([]);
  });
});

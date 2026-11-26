import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HQ_DICTS } from '../web/src/i18n.ts';

const walk = (d: string): string[] =>
  fs
    .readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const read = (d: string) =>
  walk(path.resolve(import.meta.dirname, d))
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
const server = read('../src');
const web = read('../web/src');
const has = (k: string) => Object.values(HQ_DICTS).every((d) => !!(d as Record<string, string>)[k]);

describe('HQ strings have zh-TW and en', () => {
  it('same keys, none empty', () => {
    expect(Object.keys(HQ_DICTS['zh-TW']).sort()).toEqual(Object.keys(HQ_DICTS.en).sort());
  });
  it("every t('key') in the HQ UI", () => {
    const keys = [
      ...web.matchAll(/\bt\(\s*'([\w.]+)'/g),
      ...web.matchAll(/key: '([\w.]+)'/g),
      ...web.matchAll(/'(hq\.(?:issued|emailed|saved|transferred))'/g),
    ].map((m) => m[1]);
    expect(keys.filter((k) => !has(k))).toEqual([]);
  });
  it('every audit action and error code from the HQ server', () => {
    const acts = [
      ...server.matchAll(/hqAudit\(req, '(\w+)'/g),
      ...server.matchAll(/'(staff\w+)', 'staff'/g),
    ].map((m) => m[1]);
    expect(acts.length).toBeGreaterThan(15);
    expect(acts.filter((a) => !has(`hq.act.${a}`))).toEqual([]);
    const codes = [
      ...server.matchAll(/(?:bad|denied|missing|clash)\('(\w+)'/g),
      ...server.matchAll(/HqError\(\d+, '(\w+)'/g),
    ].map((m) => m[1]);
    expect(codes.filter((c) => !has(`err.${c}`))).toEqual([]);
  });
});

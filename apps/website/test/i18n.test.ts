import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en.ts';
import { zh } from '../src/i18n/zh-TW.ts';

describe('website strings', () => {
  it('zh-TW and en have the same keys, none empty', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    for (const d of [en, zh]) for (const [k, v] of Object.entries(d)) expect(v.trim(), k).not.toBe('');
  });
  it("every t('key') used in the pages exists", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (/\.(astro|ts)$/.test(f.name)) files.push(p);
      }
    };
    walk(path.resolve(import.meta.dirname, '../src'));
    const missing: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\b[te]\('([a-zA-Z0-9.]+)'/g))
        if (!(m[1] in en)) missing.push(`${path.basename(f)}: ${m[1]}`);
      // Templates like t(`home.${p}.t`): every expansion of the listed parts must exist.
      for (const m of src.matchAll(/\bt\(`([a-z]+)\.\$\{(\w+)\}\.([a-z]+)`\)/g)) {
        const prefix = `${m[1]}.`;
        const suffix = `.${m[3]}`;
        if (!Object.keys(en).some((k) => k.startsWith(prefix) && k.endsWith(suffix)))
          missing.push(`${path.basename(f)}: ${m[0]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

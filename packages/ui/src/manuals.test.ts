import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Every manual has the same chapters in zh-TW and en, each starting with a "# " title. */
const root = path.resolve(import.meta.dirname, '../../..');
const MANUALS = {
  'HQ staff manual': 'apps/hq/web/src/help',
  'client manual (website)': 'apps/website/src/manual',
  'customer portal guide': 'apps/portal/src/help',
};

describe('manuals', () => {
  for (const [name, dir] of Object.entries(MANUALS)) {
    it(`${name}: same chapters in zh and en`, () => {
      const list = (l: string) =>
        fs
          .readdirSync(path.join(root, dir, l))
          .filter((f) => f.endsWith('.md'))
          .sort();
      const en = list('en');
      expect(en.length).toBeGreaterThan(0);
      expect(list('zh')).toEqual(en);
      for (const l of ['en', 'zh'])
        for (const f of en)
          expect(fs.readFileSync(path.join(root, dir, l, f), 'utf8'), `${l}/${f}`).toMatch(
            /^(# \S|---\ntitle: \S)/,
          );
    });
  }
});

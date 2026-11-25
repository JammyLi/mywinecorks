import { describe, expect, it } from 'vitest';
import { en } from './en.ts';
import { zhTW } from './zh-TW.ts';
import { MODULES, VISIBILITY } from '@mwc/shared';

describe('i18n', () => {
  it('zh-TW and en have the same keys, none empty', () => {
    expect(Object.keys(zhTW).sort()).toEqual(Object.keys(en).sort());
    for (const v of [...Object.values(en), ...Object.values(zhTW)]) expect(v.trim()).not.toBe('');
  });
  it('every permission module, action and visibility flag has a label', () => {
    const keys = new Set(Object.keys(en));
    for (const [m, actions] of Object.entries(MODULES)) {
      expect(keys.has(`mod.${m}`)).toBe(true);
      for (const a of actions) expect(keys.has(`act.${a}`)).toBe(true);
    }
    for (const v of VISIBILITY) expect(keys.has(`vis.${v}`)).toBe(true);
  });
});

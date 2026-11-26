import { describe, expect, it } from 'vitest';
import { cmpVersion } from './version.ts';

describe('cmpVersion', () => {
  it('orders releases and pre-releases like semver', () => {
    const v = ['0.9.0', '0.10.0', '1.0.0-beta.1', '1.0.0-beta.2', '1.0.0-beta.10', '1.0.0-rc.1', '1.0.0', '1.0.1'];
    for (let i = 0; i < v.length - 1; i++) {
      expect(cmpVersion(v[i], v[i + 1]), `${v[i]} < ${v[i + 1]}`).toBeLessThan(0);
      expect(cmpVersion(v[i + 1], v[i])).toBeGreaterThan(0);
    }
    expect(cmpVersion('1.0.0', '1.0.0')).toBe(0);
  });
});

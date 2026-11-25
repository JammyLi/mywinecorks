import { describe, expect, it } from 'vitest';
import { can, sanitizePermissions, ROLE_TEMPLATES, MODULES } from './index.ts';

describe('permissions', () => {
  it('owner template has every action', () => {
    const owner = ROLE_TEMPLATES.find((t) => t.key === 'owner')!;
    for (const [m, actions] of Object.entries(MODULES))
      for (const a of actions) expect(can(owner.permissions, m as never, a)).toBe(true);
  });
  it('only owner can create cellars by default', () => {
    for (const t of ROLE_TEMPLATES)
      expect(can(t.permissions, 'locations', 'createCellar')).toBe(t.key === 'owner');
  });
  it('sanitize drops unknown modules/actions and bad values', () => {
    const p = sanitizePermissions({
      functions: { inventory: ['view', 'hack'], nope: ['x'] },
      visibility: { seeCost: 1, bogus: true },
      locationScope: [1, -2, 'a'],
      limits: { maxStockout: -1, maxPriceChangePct: 10 },
    });
    expect(p.functions).toEqual({ inventory: ['view'] });
    expect(p.visibility.seeCost).toBe(true);
    expect('bogus' in p.visibility).toBe(false);
    expect(p.locationScope).toEqual([1]);
    expect(p.limits).toEqual({ maxOrderConfirm: null, maxPriceChangePct: 10, maxStockout: null });
  });
  it('picker cannot use back office; employee cannot see cost', () => {
    const picker = ROLE_TEMPLATES.find((t) => t.key === 'picker')!;
    const emp = ROLE_TEMPLATES.find((t) => t.key === 'employee')!;
    expect(picker.permissions.access.backOffice).toBe(false);
    expect(emp.permissions.visibility.seeCost).toBe(false);
  });
});

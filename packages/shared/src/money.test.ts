import { describe, expect, it } from 'vitest';
import { fmtMoney, toMinor, minorToInput } from './money.ts';

describe('money', () => {
  it('converts to minor units per currency', () => {
    expect(toMinor('1,609', 'TWD')).toBe(1609);
    expect(toMinor('12.5', 'USD')).toBe(1250);
    expect(toMinor('', 'USD')).toBeNull();
    expect(toMinor('abc', 'USD')).toBeNaN();
    expect(minorToInput(1250, 'USD')).toBe('12.50');
  });
  it('formats', () => {
    expect(fmtMoney(1609, 'TWD')).toBe('NT$1,609');
    expect(fmtMoney(123450, 'USD', 'en')).toBe('US$1,234.50');
    expect(fmtMoney(null, 'USD')).toBe('—');
  });
});

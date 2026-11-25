/** Money is stored as integer minor units with a currency code (CLAUDE.md rule). */
export const CURRENCIES: Record<string, number> = {
  TWD: 0,
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  HKD: 2,
  CNY: 2,
  SGD: 2,
  AUD: 2,
  CHF: 2,
  CAD: 2,
  NZD: 2,
};
export type Currency = keyof typeof CURRENCIES | string;

export const decimals = (cur: string) => CURRENCIES[cur] ?? 2;

/** "1,234.5" in USD → 123450. Returns null for empty, NaN for invalid. */
export function toMinor(input: string | number | null | undefined, cur: string): number | null {
  if (input === null || input === undefined) return null;
  const s = String(input)
    .replace(/[,\s]/g, '')
    .replace(/^(NT\$|US\$|\$)/i, '');
  if (s === '') return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  return Math.round(Number(s) * 10 ** decimals(cur));
}

export const fromMinor = (minor: number, cur: string) => minor / 10 ** decimals(cur);

export function fmtMoney(minor: number | null | undefined, cur: string, lang = 'zh-TW'): string {
  if (minor === null || minor === undefined) return '—';
  const d = decimals(cur);
  const n = fromMinor(minor, cur);
  const prefix = cur === 'TWD' ? 'NT$' : cur === 'USD' ? 'US$' : cur + ' ';
  return (
    prefix +
    n.toLocaleString(lang === 'en' ? 'en-US' : 'zh-TW', {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    })
  );
}

/** Plain number for inputs: 123450 USD → "1234.50". */
export const minorToInput = (minor: number | null | undefined, cur: string) =>
  minor === null || minor === undefined ? '' : fromMinor(minor, cur).toFixed(decimals(cur));

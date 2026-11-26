/** The app version (package builds stamp the same number into their file names). */
export const APP_VERSION = '1.0.0-beta.1';

declare const __MWC_RELEASE__: boolean | undefined;
/**
 * True in packaged builds (installer, Docker image, update packages). Release builds trust only the
 * embedded HQ key, talk to the production HQ and never read development keys.
 */
export const IS_RELEASE: boolean = typeof __MWC_RELEASE__ !== 'undefined' && !!__MWC_RELEASE__;

/**
 * Compare versions like semver: 1.0.0 > 1.0.0-beta.2 > 1.0.0-beta.1 > 0.9.0.
 * Negative when a is older, 0 when equal, positive when a is newer.
 */
export function cmpVersion(a: string, b: string): number {
  const split = (v: string) => {
    const [main, pre = ''] = v.split('-', 2) as [string, string?];
    return { main: main.split('.').map((x) => Number(x) || 0), pre: pre ? pre.split('.') : [] };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if ((x.main[i] ?? 0) !== (y.main[i] ?? 0)) return (x.main[i] ?? 0) - (y.main[i] ?? 0);
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) - (y.pre.length ? -1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const np = /^\d+$/.test(p);
    const nq = /^\d+$/.test(q);
    if (np && nq && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (np !== nq) return np ? -1 : 1;
    if (!np && p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

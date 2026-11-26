/**
 * Public keys that sign real MyWineCorks licenses and update packages. The matching private key
 * exists only in HQ (production secret store) and is never in this repository. Release builds
 * embed the HQ public key(s) at build time (scripts/release/build.mjs --trust <pem>); development
 * builds also trust the local dev HQ's key.
 */
declare const __MWC_TRUSTED_KEYS__: string[] | undefined;
export const TRUSTED_LICENSE_KEYS: string[] =
  typeof __MWC_TRUSTED_KEYS__ !== 'undefined' ? __MWC_TRUSTED_KEYS__ : [];

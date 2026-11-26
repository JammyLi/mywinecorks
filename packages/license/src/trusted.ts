/**
 * Public keys that sign real MyWineCorks licenses. The matching private key exists only in HQ
 * (production secret store) and is never in this repository. Add the production key here before
 * the first packaged release (M6); development builds also trust the local dev HQ's key.
 */
export const TRUSTED_LICENSE_KEYS: string[] = [];

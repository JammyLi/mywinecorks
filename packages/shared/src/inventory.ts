/** Inventory constants shared by server and web. */
export const BOTTLE_STATUSES = ['in_stock', 'reserved', 'shipped', 'broken', 'out'] as const;
export type BottleStatus = (typeof BOTTLE_STATUSES)[number];

/** Stock-out reasons (MyWines backlog #7). */
export const STOCKOUT_REASONS = ['own', 'gift', 'tasting', 'broken', 'shortage', 'mistake', 'other'] as const;
export type StockoutReason = (typeof STOCKOUT_REASONS)[number];

export const CASE_KINDS = ['owc6', 'owc12', 'carton6', 'carton12', 'other'] as const;

/** QR payloads printed on labels (same as MyWines, so old labels keep scanning). */
export const qr = {
  bottle: (no: string) => `MW:${no}`,
  case: (no: string) => `MW:CASE:${no}`,
  locker: (id: number) => `MW:LOCKER:${id}`,
  rack: (id: number) => `MW:RACK:${id}`,
};

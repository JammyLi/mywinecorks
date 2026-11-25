/** Inventory constants shared by server and web. */
export const BOTTLE_STATUSES = ['in_stock', 'reserved', 'shipped', 'broken', 'out'] as const;
export type BottleStatus = (typeof BOTTLE_STATUSES)[number];

/** Stock-out reasons (MyWines backlog #7). */
export const STOCKOUT_REASONS = ['own', 'gift', 'tasting', 'broken', 'shortage', 'mistake', 'other'] as const;
export type StockoutReason = (typeof STOCKOUT_REASONS)[number];

export const CASE_KINDS = ['owc6', 'owc12', 'carton6', 'carton12', 'other'] as const;

/** QR payloads printed on labels — exactly as MyWines prints them, so old and new labels scan the same. */
export const qr = {
  bottle: (no: string) => no,
  case: (no: string) => `CASE:${no}`,
  locker: (id: number) => `LOCKER:${id}`,
  rack: (id: number) => `RACK:${id}`,
};

export const LABEL_KINDS = ['bottle', 'case', 'locker', 'rack'] as const;
export type LabelKind = (typeof LABEL_KINDS)[number];
/** Label sizes in mm (MyWines presets; TSC TTP-247 default 62×29 and 100×62). */
export const LABEL_PRESETS = {
  bottle: ['62x29', '50x30', '60x40', '70x40', '40x30'],
  big: ['100x62', '100x60', '100x100', '100x150', '80x50'],
};

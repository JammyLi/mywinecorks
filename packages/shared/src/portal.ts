/**
 * Wire format between a client's MyWineCorks server and the cloud portal-service (SPEC §10.3).
 * The server sends only these fields — nothing about cost, margin, merchants, locations,
 * bottle/case numbers or other customers' prices ever leaves it (SPEC §9.3).
 */
export const PORTAL_PROTOCOL = 1;

export type PortalAccess = 'invited' | 'active' | 'suspended' | 'revoked';
export type Availability = { kind: 'exact' | 'available' | 'limited' | 'soldOut' | 'hidden'; qty?: number };

export interface PortalWine {
  ref: string;
  winery: string;
  name: string;
  vintage: string;
  country: string | null;
  region: string | null;
  classification: string | null;
  type: { code: string | null; zh: string | null; en: string | null };
  volumeMl: number;
  grapes: string | null;
  drinkFrom: number | null;
  drinkTo: number | null;
  scores: string | null;
  tastingNotes: string | null;
  photos: string[];
}

export interface PortalEntry {
  w: string; // wine ref
  price: number | null; // minor units; null = price on request
  avail: Availability;
  max: number | null;
  cats: number[];
}

export interface PortalCustomer {
  ref: string; // customer number (C-0001)
  name: string;
  email: string | null;
  lang: 'zh-TW' | 'en';
  status: PortalAccess;
  state: string | null; // US state, for shipping restrictions
  addresses: { id: number; label: string | null; address: string }[];
  entries: PortalEntry[];
}

export interface PortalRequestStatus {
  ref: string;
  status: 'received' | 'confirmed' | 'declined' | 'shipped';
  orderNo: string;
  lines: { w: string | null; name: string; qty: number; price: number | null }[];
  total: number | null;
  currency: string;
}

export interface PortalSnapshot {
  v: number;
  seq: number;
  /** Same catalogs, wines and customers as the last full copy: tenant/catalogs/wines/customers are empty. */
  unchanged?: boolean;
  /** The client's current license key (renewals reach the portal this way). */
  licenseKey?: string;
  tenant: {
    name: string;
    nameEn: string | null;
    intro: string | null;
    introEn: string | null;
    accent: string | null;
    country: 'TW' | 'US';
    currency: string;
    ageMin: number;
    blockedStates: string[];
    softHoldHours: number;
    /** AI search and wine questions offered on the portal (license has AI and the switch is on). */
    ai?: boolean;
  };
  catalogs: { id: number; name: string; nameEn: string | null; intro: string | null }[];
  wines: PortalWine[];
  customers: PortalCustomer[];
  requests: PortalRequestStatus[];
  ack: { requests: string[]; access: string[]; profile: number[]; accepted: string[] };
}

export interface PortalInbound {
  ok: boolean;
  photosMissing: string[];
  requests: {
    ref: string;
    customerRef: string;
    lines: { w: string; qty: number; price: number | null }[];
    note: string | null;
    delivery: 'ship' | 'pickup';
    address: string | null;
    createdAt: string;
  }[];
  accessRequests: {
    ref: string;
    name: string;
    email: string;
    phone: string | null;
    message: string | null;
    createdAt: string;
  }[];
  /** Customers who accepted their invitation (the client marks them active). */
  accepted: string[];
  profileUpdates: {
    id: number;
    customerRef: string;
    phone: string | null;
    lang: 'zh-TW' | 'en' | null;
    address: string | null;
    createdAt: string;
  }[];
}

/** Text signed with the client's key for every call to portal-service. */
export const portalSigningText = (ts: string, method: string, path: string, bodySha256: string) =>
  `MWC-PORTAL\n${ts}\n${method.toUpperCase()}\n${path}\n${bodySha256}`;

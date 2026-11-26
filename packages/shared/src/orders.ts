/** Orders (SPEC §8): shared by server and web so totals are computed the same way everywhere. */
export const ORDER_STATUSES = ['draft', 'confirmed', 'picked', 'shipped', 'closed', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const PAYMENT_METHODS = ['transfer', 'cash', 'card', 'cheque', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const CUSTOMER_KINDS = ['person', 'company'] as const;
export type PayStatus = 'unpaid' | 'partial' | 'paid' | 'over';

export interface LineMoney {
  qty: number;
  unit_price: number | null;
  discount: number | null;
}
/** Ex-tax line amount in minor units: qty × unit price × (1 − discount %), rounded (MyWines). */
export const lineAmount = (l: LineMoney) =>
  Math.round((l.qty || 0) * (l.unit_price || 0) * (1 - (l.discount || 0) / 100));

export function orderTotals(o: { tax_rate: number; shipping_fee: number }, lines: LineMoney[]) {
  const subtotal = lines.reduce((s, l) => s + lineAmount(l), 0);
  const tax = Math.round((subtotal * (o.tax_rate || 0)) / 100);
  const shipping = o.shipping_fee || 0;
  return {
    subtotal,
    tax,
    shipping,
    total: subtotal + tax + shipping,
    bottles: lines.reduce((s, l) => s + (l.qty || 0), 0),
  };
}

export function payStatus(total: number, paid: number): PayStatus {
  if (paid <= 0) return total <= 0 ? 'paid' : 'unpaid';
  if (paid < total) return 'partial';
  return paid > total ? 'over' : 'paid';
}

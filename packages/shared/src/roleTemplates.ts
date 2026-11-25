import { allFunctions, allVisibility, NO_LIMITS, type Permissions } from './permissions.ts';

export interface RoleTemplate {
  key: 'owner' | 'admin' | 'manager' | 'employee' | 'picker' | 'viewer';
  isOwner: boolean;
  permissions: Permissions;
}

const both = { backOffice: true, mobile: true };

export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    key: 'owner',
    isOwner: true,
    permissions: {
      functions: allFunctions(),
      visibility: allVisibility(),
      locationScope: 'all',
      limits: NO_LIMITS,
      access: both,
    },
  },
  {
    key: 'admin',
    isOwner: false,
    permissions: {
      functions: {
        inventory: ['view', 'create', 'edit', 'delete'],
        locations: ['view', 'edit', 'delete'],
        prices: ['view', 'edit'],
        orders: ['view', 'create', 'edit', 'confirm', 'ship', 'cancel'],
        customers: ['view', 'create', 'edit', 'delete'],
        catalogs: ['view', 'edit'],
        reports: ['view'],
        importExport: ['import', 'export'],
        labels: ['print'],
        settings: ['view', 'edit'],
        users: ['view', 'manage'],
        roles: ['view'],
        audit: ['view'],
      },
      visibility: allVisibility(),
      locationScope: 'all',
      limits: NO_LIMITS,
      access: both,
    },
  },
  {
    key: 'manager',
    isOwner: false,
    permissions: {
      functions: {
        inventory: ['view', 'edit'],
        locations: ['view'],
        prices: ['view', 'edit'],
        orders: ['view', 'create', 'edit', 'confirm', 'ship', 'cancel'],
        customers: ['view', 'create', 'edit'],
        catalogs: ['view', 'edit'],
        reports: ['view'],
        importExport: ['export'],
        labels: ['print'],
      },
      visibility: {
        seeCost: false,
        seeProfit: true,
        seeMerchants: false,
        seeCustomerPrices: true,
        seeOthersOrders: true,
      },
      locationScope: 'all',
      limits: NO_LIMITS,
      access: both,
    },
  },
  {
    key: 'employee',
    isOwner: false,
    permissions: {
      functions: {
        inventory: ['view', 'create', 'edit'],
        locations: ['view'],
        prices: ['view', 'edit'],
        orders: ['view', 'create', 'edit', 'ship'],
        customers: ['view'],
        labels: ['print'],
      },
      visibility: {
        seeCost: false,
        seeProfit: false,
        seeMerchants: false,
        seeCustomerPrices: true,
        seeOthersOrders: true,
      },
      locationScope: 'all',
      limits: { maxOrderConfirm: null, maxPriceChangePct: 20, maxStockout: 6 },
      access: both,
    },
  },
  {
    key: 'picker',
    isOwner: false,
    permissions: {
      functions: { inventory: ['view', 'edit'], locations: ['view'], orders: ['view', 'ship'] },
      visibility: {},
      locationScope: 'all',
      limits: { maxOrderConfirm: null, maxPriceChangePct: null, maxStockout: 0 },
      access: { backOffice: false, mobile: true },
    },
  },
  {
    key: 'viewer',
    isOwner: false,
    permissions: {
      functions: {
        inventory: ['view'],
        locations: ['view'],
        prices: ['view'],
        orders: ['view'],
        customers: ['view'],
        catalogs: ['view'],
        reports: ['view'],
        audit: ['view'],
      },
      visibility: {
        seeCost: true,
        seeProfit: true,
        seeMerchants: true,
        seeCustomerPrices: true,
        seeOthersOrders: true,
      },
      locationScope: 'all',
      limits: NO_LIMITS,
      access: { backOffice: true, mobile: false },
    },
  },
];

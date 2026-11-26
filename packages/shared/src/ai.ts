/**
 * AI features (SPEC §11). Client servers and the portal service call the cloud ai-gateway; the
 * gateway holds the Claude API key, the prompts and the output schemas, and meters usage.
 * Rule: AI never changes data — every result is a suggestion the user confirms, with its source.
 */
export const AI_FEATURES = [
  'label',
  'invoice',
  'search',
  'drinking',
  'ask',
  'price',
  'orderMessage',
  'portalSearch',
  'portalQa',
] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

/** Per-workspace switches (Settings › AI). "portal" covers portalSearch and portalQa. */
export const AI_SWITCHES = [
  'label',
  'invoice',
  'search',
  'drinking',
  'ask',
  'price',
  'orderMessage',
  'portal',
] as const;
export type AiSwitch = (typeof AI_SWITCHES)[number];

export interface AiImage {
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
  data: string; // base64
}

// ---------------------------------------------------------------- results

export interface LabelResult {
  winery: string | null;
  name: string | null;
  vintage: string | null; // 4 digits or 'NV'
  country: string | null;
  region: string | null;
  classification: string | null;
  typeCode: string | null;
  volumeMl: number | null;
  grapes: string | null;
  confidence: 'high' | 'medium' | 'low';
  notes: string | null;
}

export interface InvoiceResult {
  merchant: string | null;
  invoiceNo: string | null;
  date: string | null; // YYYY-MM-DD
  currency: string | null;
  lines: {
    winery: string | null;
    name: string;
    vintage: string | null;
    volumeMl: number | null;
    qty: number;
    unitPrice: number | null; // in the invoice currency, major units (e.g. 1234.5)
  }[];
  extraCosts: number | null;
}

export interface SearchResult {
  q: string | null;
  types: string[];
  country: string | null;
  region: string | null;
  vintageFrom: string | null;
  vintageTo: string | null;
  priceMin: number | null; // major units of the workspace currency
  priceMax: number | null;
  cellar: string | null; // a cellar name from the list given
  explanation: string;
}

export interface DrinkingResult {
  wines: { ref: string; drinkFrom: number | null; drinkTo: number | null; reason: string }[];
}

export interface PriceResult {
  price: number; // major units
  reason: string;
}

export interface OrderMessageResult {
  customer: string | null;
  lines: { text: string; qty: number; winery: string | null; name: string | null; vintage: string | null }[];
  delivery: 'ship' | 'pickup' | null;
  note: string | null;
}

export interface PortalSearchResult {
  refs: string[];
  explanation: string;
}

export interface PortalQaResult {
  answer: string;
}

// ---------------------------------------------------------------- cellar Q&A tools (run on the client server)

export interface AskTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export const ASK_TOOLS: AskTool[] = [
  {
    name: 'stock_summary',
    description:
      'Bottles in stock and their market value, grouped. Use for questions about what is in the cellar, how much of something, where, or what it is worth.',
    input_schema: {
      type: 'object',
      properties: {
        group_by: { type: 'string', enum: ['type', 'country', 'region', 'cellar', 'wine', 'vintage'] },
        filters: {
          type: 'object',
          properties: {
            q: { type: 'string' },
            type: { type: 'string' },
            country: { type: 'string' },
            region: { type: 'string' },
            vintage_from: { type: 'string' },
            vintage_to: { type: 'string' },
          },
        },
        limit: { type: 'integer' },
      },
      required: ['group_by'],
    },
  },
  {
    name: 'purchases',
    description:
      'What was bought (bottles and amount spent), grouped, in a date range. Needs permission to see cost.',
    input_schema: {
      type: 'object',
      properties: {
        group_by: { type: 'string', enum: ['type', 'country', 'region', 'merchant', 'month', 'wine'] },
        from: { type: 'string', description: 'YYYY-MM-DD' },
        to: { type: 'string', description: 'YYYY-MM-DD' },
        filters: {
          type: 'object',
          properties: {
            q: { type: 'string' },
            region: { type: 'string' },
            country: { type: 'string' },
            type: { type: 'string' },
          },
        },
      },
      required: ['group_by'],
    },
  },
  {
    name: 'value_change',
    description:
      'Wines in stock with their purchase cost and latest market price, sorted by gain ratio. Needs permission to see cost.',
    input_schema: {
      type: 'object',
      properties: {
        min_ratio: { type: 'number', description: 'e.g. 2 for doubled' },
        limit: { type: 'integer' },
      },
    },
  },
  {
    name: 'sales',
    description:
      'Shipped orders: bottles and revenue, grouped, in a date range. Needs permission to see customer prices.',
    input_schema: {
      type: 'object',
      properties: {
        group_by: { type: 'string', enum: ['month', 'customer', 'wine'] },
        from: { type: 'string' },
        to: { type: 'string' },
      },
      required: ['group_by'],
    },
  },
  {
    name: 'drinking_window',
    description: 'Wines in stock that are entering, at, or past their drinking window this year.',
    input_schema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['entering', 'peak', 'past', 'all'] } },
    },
  },
];

export interface AskResponse {
  /** Claude's content blocks (text and tool_use), passed back as they are for the next turn. */
  content: (
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  )[];
  stopReason: string;
}

/** Text signed with the workspace's key for calls to MyWineCorks cloud services. */
export const serviceSigningText = (ts: string, method: string, path: string, bodySha256: string) =>
  `MWC-PORTAL\n${ts}\n${method.toUpperCase()}\n${path}\n${bodySha256}`;

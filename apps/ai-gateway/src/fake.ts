/**
 * A stand-in for Claude, for tests and for trying the app before an API key exists
 * (AI_FAKE=1, never in production). Answers are fixed, plausible examples per feature —
 * they are not read from the photos or text sent.
 */
import type { ClaudeRequest, ClaudeResponse, Provider } from './provider.ts';

const tool = (input: Record<string, unknown>): ClaudeResponse => ({
  content: [{ type: 'tool_use', id: 'fake_' + Math.random().toString(36).slice(2), name: 'result', input }],
  stop_reason: 'tool_use',
  usage: { input_tokens: 500, output_tokens: 120 },
});

const lastText = (r: ClaudeRequest) => {
  const m = r.messages[r.messages.length - 1];
  const c = Array.isArray(m?.content) ? (m.content as { type: string; text?: string }[]) : [];
  return c
    .filter((x) => x.type === 'text')
    .map((x) => x.text ?? '')
    .join('\n');
};

export function fakeProvider(): Provider {
  return async (r) => {
    const s = r.system;
    if (r.tool_choice?.type === 'auto') return fakeAsk(r);
    if (s.includes('wine label'))
      return tool({
        winery: 'Domaine Fake',
        name: 'Bourgogne Rouge',
        vintage: '2019',
        country: 'France',
        region: 'Bourgogne',
        classification: 'AOC',
        typeCode: 'R',
        volumeMl: 750,
        grapes: 'Pinot Noir',
        confidence: 'medium',
        notes: 'Example answer (no API key yet).',
      });
    if (s.includes('merchant invoice'))
      return tool({
        merchant: 'Example Wine Merchant',
        invoiceNo: 'INV-0001',
        date: new Date().toISOString().slice(0, 10),
        currency: 'TWD',
        extraCosts: 500,
        lines: [
          {
            winery: 'Domaine Fake',
            name: 'Bourgogne Rouge',
            vintage: '2019',
            volumeMl: 750,
            qty: 6,
            unitPrice: 1200,
          },
          {
            winery: 'Château Exemple',
            name: 'Bordeaux Supérieur',
            vintage: '2018',
            volumeMl: 750,
            qty: 12,
            unitPrice: 900,
          },
        ],
      });
    if (s.includes('filters for a wine stock search')) {
      const input = JSON.parse(lastText(r) || '{}') as {
        search?: string;
        types?: { code: string; en: string; zh: string }[];
        regions?: string[];
      };
      const t = input.search ?? '';
      const tl = t.toLowerCase();
      const m = t.match(/(\d{3,6})/);
      return tool({
        q: null,
        types: (input.types ?? [])
          .filter((x) => t.includes(x.zh) || tl.includes(x.en.toLowerCase().replace(/ wine$/, '')))
          .map((x) => x.code),
        country: null,
        region:
          (input.regions ?? []).find((x) => tl.includes(x.toLowerCase())) ??
          (/布根地|burgundy/i.test(t) ? 'Bourgogne' : null),
        vintageFrom: null,
        vintageTo: null,
        priceMin: null,
        priceMax: m ? Number(m[1]) : null,
        cellar: null,
        explanation: 'Example filters (no API key yet).',
      });
    }
    if (s.includes('drinking window')) {
      const wines = JSON.parse(lastText(r) || '[]') as { ref: string; vintage: string }[];
      return tool({
        wines: wines.map((w) => {
          const v = Number(w.vintage);
          return Number.isFinite(v)
            ? { ref: w.ref, drinkFrom: v + 4, drinkTo: v + 15, reason: 'Example window (no API key yet).' }
            : { ref: w.ref, drinkFrom: null, drinkTo: null, reason: 'Not sure.' };
        }),
      });
    }
    if (s.includes('selling price')) {
      const i = JSON.parse(lastText(r) || '{}') as {
        suggested?: number | null;
        customerPrices?: { price: number }[];
        market?: { price: number }[];
      };
      const p = i.customerPrices?.[0]?.price ?? i.suggested ?? i.market?.[0]?.price ?? 1000;
      return tool({ price: p, reason: 'Example: kept in line with the figures given (no API key yet).' });
    }
    if (s.includes('message from a customer'))
      return tool({
        customer: null,
        delivery: null,
        note: null,
        lines:
          lastText(r)
            .split('Message:\n')[1]
            ?.split('\n')
            .map((l) => l.trim())
            .filter((l) => l && l !== '(see the image)')
            .slice(0, 20)
            .map((l) => ({
              text: l,
              qty: Number(l.match(/(\d+)\s*(?:瓶|bottles?|btl|x)/i)?.[1] ?? 1),
              winery: null,
              name: l.replace(/\d+\s*(瓶|bottles?|btl|x)/gi, '').trim() || null,
              vintage: l.match(/\b(19|20)\d{2}\b/)?.[0] ?? null,
            })) ?? [],
      });
    if (s.includes("searches a wine shop's list")) {
      const i = JSON.parse(lastText(r) || '{}') as { text: string; wines: { ref: string; label: string }[] };
      const words = i.text.toLowerCase().split(/\s+/).filter(Boolean);
      return tool({
        refs: i.wines.filter((w) => words.some((x) => w.label.toLowerCase().includes(x))).map((w) => w.ref),
        explanation: 'Example search (no API key yet).',
      });
    }
    if (s.includes('asks about one wine')) return tool({ answer: 'Example answer (no API key yet).' });
    return tool({});
  };
}

/** Cellar Q&A: first ask for stock by type, then answer with what came back. */
function fakeAsk(r: ClaudeRequest): ClaudeResponse {
  const last = r.messages[r.messages.length - 1];
  const results = Array.isArray(last.content)
    ? (last.content as { type: string; content?: string }[]).filter((c) => c.type === 'tool_result')
    : [];
  if (!results.length)
    return {
      content: [
        { type: 'text', text: '' },
        { type: 'tool_use', id: 'fake_ask_1', name: 'stock_summary', input: { group_by: 'type', limit: 10 } },
      ].filter((c) => c.type !== 'text') as ClaudeResponse['content'],
      stop_reason: 'tool_use',
      usage: { input_tokens: 800, output_tokens: 40 },
    };
  return {
    content: [
      {
        type: 'text',
        text: `Example answer (no API key yet). The cellar data returned: ${String(results[0].content ?? '').slice(0, 400)}`,
      },
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1200, output_tokens: 80 },
  };
}

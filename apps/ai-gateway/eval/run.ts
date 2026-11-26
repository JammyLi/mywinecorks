/**
 * AI accuracy checks (SPEC §10.5). Runs every case in eval/cases/*.json (and eval/private/*.json,
 * which is not committed: real labels and invoices from clients) through the same prompts the
 * gateway uses, and scores each expected field.
 *
 *   pnpm --filter @mwc/ai-gateway eval            # real Claude (ANTHROPIC_API_KEY in .env)
 *   pnpm --filter @mwc/ai-gateway eval -- --fake  # fixed answers (checks the harness only)
 *   … -- --only label --min 0.9                   # one feature; fail below 90 %
 *
 * A case: { "feature": "label", "input": {…} | "images": ["private/img/x.jpg"], "expect": {…} }.
 * expect lists only the fields that matter; strings compare case- and accent-insensitively,
 * arrays compare as sets, { "contains": "…" } checks a substring.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FEATURES, buildRequest } from '../src/features.ts';
import { fakeProvider } from '../src/fake.ts';
import { anthropic } from '../src/provider.ts';
import { loadConfig } from '../src/config.ts';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const cfg = loadConfig();
const provider = flag('--fake') ? fakeProvider() : cfg.apiKey ? anthropic(cfg.apiKey) : null;
if (!provider) {
  console.error('No ANTHROPIC_API_KEY. Use --fake to check the harness without Claude.');
  process.exit(2);
}

interface Case {
  name?: string;
  feature: keyof typeof FEATURES;
  input?: Record<string, unknown>;
  images?: string[];
  expect: Record<string, unknown>;
}
const root = import.meta.dirname;
const load = (dir: string) =>
  fs.existsSync(path.join(root, dir))
    ? fs
        .readdirSync(path.join(root, dir))
        .filter((f) => f.endsWith('.json'))
        .flatMap((f) => {
          const v = JSON.parse(fs.readFileSync(path.join(root, dir, f), 'utf8')) as Case | Case[];
          return (Array.isArray(v) ? v : [v]).map((c, i) => ({ ...c, name: c.name ?? `${f}#${i + 1}` }));
        })
    : [];
const cases = [...load('cases'), ...load('private')].filter(
  (c) => !opt('--only') || c.feature === opt('--only'),
);

const norm = (v: unknown) =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
function same(got: unknown, want: unknown): boolean {
  if (want && typeof want === 'object' && !Array.isArray(want) && 'contains' in want)
    return norm(got).includes(norm((want as { contains: string }).contains));
  if (Array.isArray(want)) {
    if (!Array.isArray(got)) return false;
    const g = new Set(got.map(norm));
    return want.length === g.size && want.every((w) => g.has(norm(w)));
  }
  if (typeof want === 'number') return Number(got) === want;
  if (want === null) return got === null || got === undefined || got === '';
  return norm(got) === norm(want);
}
function pick(obj: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((o, k) => (o == null ? o : (o as Record<string, unknown>)[k]), obj);
}

const img = (p: string) => {
  const ext = path.extname(p).toLowerCase();
  const mime = ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : 'image/jpeg';
  return { mime, data: fs.readFileSync(path.join(root, p)).toString('base64') };
};

const score: Record<string, { fields: number; ok: number; cases: number; tokens: number }> = {};
let failedCases = 0;
for (const c of cases) {
  const f = FEATURES[c.feature];
  const input =
    c.feature === 'label'
      ? { types: [], ...c.input, images: (c.images ?? []).map(img) }
      : c.feature === 'invoice'
        ? { ...c.input, file: img(c.images![0]) }
        : c.feature === 'orderMessage' && c.images
          ? { customers: [], ...c.input, image: img(c.images[0]) }
          : c.input;
  const s = (score[c.feature] ??= { fields: 0, ok: 0, cases: 0, tokens: 0 });
  s.cases++;
  let out: unknown;
  try {
    const res = await provider(
      buildRequest(f, { main: cfg.model, fast: cfg.fastModel }, f.input.parse(input)),
    );
    s.tokens += res.usage.input_tokens + res.usage.output_tokens;
    const tool = res.content.find((x) => x.type === 'tool_use');
    out = f.output.parse(tool && 'input' in tool ? tool.input : null);
  } catch (e) {
    console.log(`✗ ${c.name}: ${(e as Error).message}`);
    s.fields += Object.keys(c.expect).length;
    failedCases++;
    continue;
  }
  const bad: string[] = [];
  for (const [k, want] of Object.entries(c.expect)) {
    s.fields++;
    const got = pick(out, k);
    if (same(got, want)) s.ok++;
    else bad.push(`${k}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
  if (bad.length) failedCases++;
  console.log(`${bad.length ? '✗' : '✓'} ${c.name}${bad.length ? '\n    ' + bad.join('\n    ') : ''}`);
}

console.log('\nfeature        cases  fields correct   tokens');
let worst = 1;
for (const [k, s] of Object.entries(score)) {
  const r = s.fields ? s.ok / s.fields : 1;
  worst = Math.min(worst, r);
  console.log(
    `${k.padEnd(14)} ${String(s.cases).padStart(5)}  ${String(s.fields).padStart(6)} ${(r * 100).toFixed(1).padStart(6)} % ${String(s.tokens).padStart(8)}`,
  );
}
const min = Number(opt('--min') ?? 0);
if (!cases.length) console.log('No cases.');
process.exit(worst < min ? 1 : 0);

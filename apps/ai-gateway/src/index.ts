import { createGateway } from './app.ts';
import { loadConfig } from './config.ts';
import { fakeProvider } from './fake.ts';

const cfg = loadConfig();
// AI_FAKE=1 answers with fixed examples so the app can be tried before an API key exists.
// Development without a key answers with fixed examples (AI_FAKE=0 turns that off).
const fake = !cfg.production && !cfg.apiKey && process.env.AI_FAKE !== '0';
const { app } = await createGateway(cfg, fake ? { provider: fakeProvider() } : {});
app.listen(cfg.port, () =>
  console.log(
    `MyWineCorks AI gateway on :${cfg.port} (${cfg.apiKey ? 'Claude' : fake ? 'fake answers — no API key' : 'not configured — set ANTHROPIC_API_KEY'})`,
  ),
);

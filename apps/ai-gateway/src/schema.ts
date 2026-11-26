/** ai-gateway schema: registered clients, usage per call (no prompts or answers are stored), caps. */
export const MIGRATIONS = [
  {
    id: 1,
    name: 'ai_foundations',
    sql: `
CREATE TABLE clients (
  id SERIAL PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  lid TEXT NOT NULL UNIQUE,
  client TEXT NOT NULL,
  license_key TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE usage (
  id BIGSERIAL PRIMARY KEY,
  lid TEXT NOT NULL,
  feature TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INT NOT NULL,
  output_tokens INT NOT NULL,
  ok BOOLEAN NOT NULL DEFAULT true,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX usage_lid_at ON usage(lid, at);
CREATE TABLE caps (
  lid TEXT PRIMARY KEY,
  monthly_tokens INT NOT NULL,
  set_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
`,
  },
];

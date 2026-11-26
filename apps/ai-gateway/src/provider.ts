/** Claude Messages API (the gateway is the only place with the API key). */
export interface ClaudeRequest {
  model: string;
  system: string;
  messages: { role: 'user' | 'assistant'; content: unknown }[];
  tools?: { name: string; description: string; input_schema: Record<string, unknown> }[];
  tool_choice?: { type: 'tool'; name: string } | { type: 'auto' };
  max_tokens: number;
}
export interface ClaudeResponse {
  content: (
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  )[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}
export type Provider = (r: ClaudeRequest) => Promise<ClaudeResponse>;

export class ProviderError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

export function anthropic(apiKey: string): Provider {
  return async (r) => {
    let res: Response;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(r),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new ProviderError(502, 'aiUnreachable');
    }
    const data = (await res.json().catch(() => ({}))) as ClaudeResponse & { error?: { type?: string } };
    if (!res.ok)
      throw new ProviderError(
        res.status === 429 || res.status === 529 ? 503 : 502,
        res.status === 429 || res.status === 529 ? 'aiBusy' : 'aiError',
      );
    return data;
  };
}

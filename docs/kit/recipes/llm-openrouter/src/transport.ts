// How a request reaches OpenRouter. Tests use a recording; nothing in the
// unit suite reaches the network.
export type ChatRequest = Record<string, unknown>;
export type ChatResponse = { status: number; body: unknown };
export type Transport = (request: ChatRequest) => Promise<ChatResponse>;

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export function openRouterTransport(opts: {
  apiKey: string;
  /** Optional attribution headers OpenRouter documents. */
  referer?: string;
  title?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): Transport {
  const doFetch = opts.fetch ?? fetch;
  return async (request) => {
    const res = await doFetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        "content-type": "application/json",
        ...(opts.referer ? { "HTTP-Referer": opts.referer } : {}),
        ...(opts.title ? { "X-Title": opts.title } : {}),
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

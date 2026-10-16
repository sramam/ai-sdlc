// Recorded responses for tests, and the wrapper the recording script uses.
// Kept apart from transport.ts so the runtime path imports no Node module.
import { createHash } from "node:crypto";
import type { ChatRequest, ChatResponse, Transport } from "./transport";

/** A stable key for a request: the same prompt, model and routing replay the same answer. */
export function requestKey(request: ChatRequest): string {
  const canonical = JSON.stringify(request, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export type Cassette = Record<string, { request: ChatRequest; response: ChatResponse }>;

/** Replays recorded responses. A request with no recording throws, naming its key. */
export function recordedTransport(cassette: Cassette): Transport {
  return async (request) => {
    const key = requestKey(request);
    const hit = cassette[key];
    if (!hit) {
      throw new Error(
        `LLM-REC-001: no recording for request ${key} — the prompt, model or routing changed; re-record (README § Recording)`,
      );
    }
    return structuredClone(hit.response);
  };
}

/** Wraps a real transport and keeps what it sees, for the recording script. Never used in tests. */
export function recordingTransport(inner: Transport, cassette: Cassette): Transport {
  return async (request) => {
    const response = await inner(request);
    cassette[requestKey(request)] = { request, response };
    return response;
  };
}

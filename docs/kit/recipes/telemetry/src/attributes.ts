// The attribute registry: every attribute a span may carry, declared once, with
// whether it can hold personal data. An undeclared key is refused — it throws
// under the test tracer and is dropped in production — so an email or a token
// cannot reach a trace through an object spread.
export const ATTRIBUTES = {
  "app.capability": { kind: "string", pii: false, doc: "the port function, e.g. note.list" },
  "app.outcome": { kind: "string", pii: false, doc: "ok | refused | error" },
  "app.refusal.code": { kind: "string", pii: false, doc: "the Refusal code when refused" },
  "app.caller.role": { kind: "string", pii: false, doc: "the caller's role" },
  "app.rows": { kind: "number", pii: false, doc: "rows read or written" },
} as const;

export type AttributeKey = keyof typeof ATTRIBUTES;
export type AttributeValue = string | number | boolean;
export type Attributes = Partial<Record<AttributeKey, AttributeValue>>;

/** Split attributes into the declared ones of the right type, and the rest. */
export function checkAttributes(attrs: Record<string, unknown>): {
  ok: Record<string, AttributeValue>;
  rejected: string[];
} {
  const ok: Record<string, AttributeValue> = {};
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    const spec = (ATTRIBUTES as Record<string, { kind: string } | undefined>)[key];
    if (!spec || typeof value !== spec.kind) rejected.push(key);
    else ok[key] = value as AttributeValue;
  }
  return { ok, rejected };
}

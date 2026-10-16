// The span helper the PORT uses. Runtime-free — no `cloudflare:` import — so a
// capability is traced the same way under workerd and under Node tests: the
// binding hands it `workersTracer`, a test hands it `memoryTracer()`.
import { checkAttributes, type AttributeValue, type Attributes } from "./attributes";

export interface SpanLike {
  setAttributes(attributes: Record<string, AttributeValue>): unknown;
  recordException?(error: unknown): unknown;
}

export interface Tracer {
  enterSpan<T>(name: string, fn: (span: SpanLike) => Promise<T>): Promise<T>;
  /** "throw" under test, "drop" in production. */
  onUnknownAttribute: "throw" | "drop";
}

export const noopTracer: Tracer = {
  onUnknownAttribute: "drop",
  enterSpan: (_name, fn) => fn({ setAttributes: () => {} }),
};

/**
 * One span around `fn`. The outcome is read from the result's shape: a
 * `{ ok: false, code }` refusal is `refused`, a throw is `error`.
 */
export async function inSpan<T>(
  tracer: Tracer,
  name: string,
  attributes: Attributes,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.enterSpan(name, async (span) => {
    const set = (attrs: Record<string, unknown>) => {
      const { ok, rejected } = checkAttributes(attrs);
      if (rejected.length && tracer.onUnknownAttribute === "throw") {
        throw new Error(
          `TEL-001: undeclared span attribute(s): ${rejected.join(", ")} — declare them in ATTRIBUTES`,
        );
      }
      span.setAttributes(ok);
    };
    set(attributes);
    try {
      const result = await fn();
      const r = result as { ok?: unknown; code?: unknown } | undefined;
      set(
        r && r.ok === false
          ? { "app.outcome": "refused", "app.refusal.code": r.code }
          : { "app.outcome": "ok" },
      );
      return result;
    } catch (error) {
      set({ "app.outcome": "error" });
      span.recordException?.(error);
      throw error;
    }
  });
}

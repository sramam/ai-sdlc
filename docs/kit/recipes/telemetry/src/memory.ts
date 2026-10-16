// The test exporter: spans recorded in memory, parented by async context
// (AsyncLocalStorage), the same rule Workers uses — so concurrent spans nest
// correctly rather than by call order.
import { AsyncLocalStorage } from "node:async_hooks";
import type { AttributeValue } from "./attributes";
import type { Tracer } from "./span";

export type RecordedSpan = {
  name: string;
  parent: string | null;
  attributes: Record<string, AttributeValue>;
  error?: string;
};

export function memoryTracer(): Tracer & { spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const current = new AsyncLocalStorage<RecordedSpan>();
  return {
    spans,
    onUnknownAttribute: "throw",
    enterSpan(name, fn) {
      const span: RecordedSpan = { name, parent: current.getStore()?.name ?? null, attributes: {} };
      spans.push(span);
      return current.run(span, () =>
        fn({
          setAttributes: (a) => Object.assign(span.attributes, a),
          recordException: (e) => (span.error = String(e)),
        }),
      );
    },
  };
}

// Binding side only: Workers' native custom spans (`tracing` from
// `cloudflare:workers`). They nest under the platform's own request span and
// are exported by Cloudflare's OTLP export when `observability.traces` is
// enabled with `destinations` (wrangler.jsonc). The port never imports this.
import { tracing } from "cloudflare:workers";
import type { Tracer } from "./span";

export const workersTracer: Tracer = {
  onUnknownAttribute: "drop",
  enterSpan: (name, fn) => tracing.enterSpan(name, (span) => fn(span)),
};

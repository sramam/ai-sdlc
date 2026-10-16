// The HTTP binding: a plain `(Request) => Promise<Response>`, rendered from the
// manifest. It mounts in a TanStack Start server route (`/api/$`) and runs on
// Workers unchanged: no Node API, no framework.
//
// Every capability is `POST <base>/<entity>/<verb>` with a JSON body, reads
// included (README § Why POST for reads). The response is the capability's
// output (200) or its refusal, with the status the refusal's code maps to.
import { invoke, type Capability, type Deps } from "../../../api/src/capability";
import type { Exclusions } from "../../../api/src/manifest";
import { refuse, type Refusal } from "../../../api/src/refusal";
import type { Authenticated } from "../auth/principal";
import { withinScope } from "../auth/principal";
import { httpPath, reachable, statusFor } from "../surface";

export type HttpOptions = {
  manifest: readonly Capability[];
  exclusions: Exclusions;
  /** Where the router is mounted, e.g. `/api`. */
  basePath: string;
  /** `authenticate` from ../auth/principal.ts, bound to the project's verifiers. */
  authenticate(request: Request): Promise<Authenticated | Refusal | null>;
  /** The port's dependencies for this request (database, authz, span helper). */
  deps(request: Request): Deps | Promise<Deps>;
  /** Per-caller rate limit (Cloudflare's rate-limiting binding, or a Durable Object). False = refuse. */
  limit?(key: string): Promise<boolean>;
  /** A defect (a throw). Report it; the response says nothing about it. */
  onError?(error: unknown): void;
  /** Default 1 MiB. */
  maxBodyBytes?: number;
};

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

const reply = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
const refusal = (r: Refusal, status = statusFor(r), headers?: Record<string, string>) =>
  reply(r, status, headers);

export function createHttpHandler(o: HttpOptions): (request: Request) => Promise<Response> {
  const routes = new Map<string, Capability>();
  for (const cap of o.manifest) {
    if (reachable(cap.name, "http", o.exclusions)) routes.set(o.basePath + httpPath(cap.name), cap);
  }
  const maxBody = o.maxBodyBytes ?? 1024 * 1024;

  return async (request) => {
    try {
      const cap = routes.get(new URL(request.url).pathname);
      if (!cap) return refusal(refuse("NOT_FOUND", "No such capability."));
      if (request.method !== "POST")
        return refusal(refuse("INVALID", "Use POST."), 405, { allow: "POST" });
      // JSON only: a cross-site form cannot send it without a CORS preflight (CSRF).
      if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? ""))
        return refusal(refuse("INVALID", "Send a JSON body."), 415);

      const who = await o.authenticate(request);
      if (who === null)
        return refusal(refuse("FORBIDDEN", "Sign in, or send a valid API key."), 401, {
          "www-authenticate": 'Bearer realm="api"',
        });
      if ("ok" in who) return refusal(who);
      if (!withinScope(who.scopes, cap.effect))
        return refusal(refuse("FORBIDDEN", "This credential's scope does not allow that."));
      if (o.limit && !(await o.limit(who.rateKey)))
        return refusal(refuse("UNAVAILABLE", "Too many requests. Try again shortly."), 429, {
          "retry-after": "60",
        });

      const text = await request.text();
      if (text.length > maxBody) return refusal(refuse("INVALID", "The body is too large."), 413);
      let raw: unknown = {};
      if (text.trim()) {
        try {
          raw = JSON.parse(text);
        } catch {
          return refusal(refuse("INVALID", "The body is not valid JSON."));
        }
      }
      const result = await invoke(cap, await o.deps(request), who.caller, raw);
      return (result as { ok: boolean }).ok ? reply(result, 200) : refusal(result as Refusal);
    } catch (error) {
      o.onError?.(error);
      return reply({ ok: false, code: "INTERNAL", detail: "Something went wrong." }, 500);
    }
  };
}

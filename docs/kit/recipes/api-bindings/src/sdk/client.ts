// The SDK: a typed client over the HTTP binding, built from the manifest's
// TYPE alone. Nothing is generated, so nothing can be stale: a capability added
// to the manifest is a method here at the next compile, typed from its own
// input and output schemas.
//
//   const api = createClient<typeof manifest, typeof exclusions>({ baseUrl: "/api" });
//   const r = await api.project.create({ name: "Roof" });
//   if (!r.ok) form.setError(r.field ?? "root", { message: r.detail });
//
// Runtime-free (browser, Node, Workers): `fetch` and nothing else. The only
// imports are types and the pure path function the router uses too.
//
// A refusal is RETURNED, as the port returns it. A defect (5xx other than 503,
// a body that is not ours, a network failure) THROWS, as the port throws.
import type { z } from "zod";
import type { Refusal } from "../../../api/src/refusal";
import { httpPath } from "../surface";

type Cap = { readonly name: string; readonly input: z.ZodType; readonly output: z.ZodType };

/** Capability names an exclusions table keeps out of the SDK. */
type SdkExcluded<X> = { [K in keyof X]: X[K] extends { sdk: string } ? K : never }[keyof X];

type Offered<M extends readonly Cap[], X> = Exclude<M[number], { name: SdkExcluded<X> }>;

export type Sdk<M extends readonly Cap[], X = object> = {
  [E in Offered<M, X>["name"] extends `${infer En}.${string}` ? En : never]: {
    [C in Offered<M, X> as C["name"] extends `${E}.${infer V}` ? V : never]: (
      input: z.input<C["input"]>,
    ) => Promise<z.output<C["output"]> | Refusal>;
  };
};

export type ClientOptions = {
  /** Where the HTTP binding is mounted: `/api` same-origin, or `https://app.example.com/api`. */
  baseUrl: string;
  /** Defaults to the global fetch. Tests pass one bound to the router. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Programmatic clients: `{ authorization: "Bearer <api key>" }`. Browsers send the cookie. */
  headers?:
    Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
};

const REFUSAL_CODES = new Set(["INVALID", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "UNAVAILABLE"]);

export function createClient<M extends readonly Cap[], X = object>(o: ClientOptions): Sdk<M, X> {
  const doFetch = o.fetch ?? ((input, init) => fetch(input, init));
  const call = async (name: string, input: unknown) => {
    const extra = typeof o.headers === "function" ? await o.headers() : (o.headers ?? {});
    const res = await doFetch(o.baseUrl + httpPath(name), {
      method: "POST",
      headers: { "content-type": "application/json", ...extra },
      body: JSON.stringify(input ?? {}),
      credentials: "same-origin",
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(`SDK-001: ${name} answered ${res.status} with a body that is not JSON`);
    }
    const b = body as { ok?: unknown; code?: unknown };
    if (res.ok && b.ok === true) return body;
    if (b.ok === false && REFUSAL_CODES.has(b.code as string)) return body as Refusal;
    throw new Error(`SDK-002: ${name} answered ${res.status} (${String(b.code ?? "no code")})`);
  };
  // Two levels of Proxy: `client.<entity>.<verb>(input)`.
  return new Proxy({} as Sdk<M, X>, {
    get: (_t, entity) =>
      // `then` stays undefined, so awaiting the client is not mistaken for a call.
      typeof entity !== "string" || entity === "then"
        ? undefined
        : new Proxy(
            {},
            {
              get: (_u, verb) =>
                typeof verb !== "string" || verb === "then"
                  ? undefined
                  : (input: unknown) => call(`${entity}.${verb}`, input),
            },
          ),
  });
}

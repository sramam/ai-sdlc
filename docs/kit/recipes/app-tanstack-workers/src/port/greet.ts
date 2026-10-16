// A port function: framework-free and runtime-free (no TanStack, React or
// `cloudflare:` imports), so it is tested in Node. In a project it lives in
// packages/api; the server function is only its transport.
import { z } from "zod";

export const greetInput = z.object({ name: z.string().min(1).max(80) });
export type Caller = { userId: string | null; role: string };
export type Refusal = { ok: false; code: string; detail: string; field?: string };

export function greet(caller: Caller, input: z.infer<typeof greetInput>) {
  if (input.name.toLowerCase() === "nobody") {
    return {
      ok: false,
      code: "INVALID",
      detail: "name: nobody is not a name",
      field: "name",
    } satisfies Refusal;
  }
  return { ok: true as const, greeting: `Hello, ${input.name}`, as: caller.role };
}

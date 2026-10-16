// `@scope/llm`: the one way the product calls a model.
//
//   generate({ role, dataClass, tenantId, runId, messages, schema })
//     → routing by data class (refused without one)
//     → cost caps, per run and per tenant per UTC day, checked BEFORE the call
//     → OpenRouter, structured output only, no model fallback
//     → the answer validated by the Zod schema (model output is untrusted input)
//
// Returns `{ ok: true, value, usage }` or an `LlmRefusal`; never throws for a
// policy reason. A thrown error is a defect (or a missing recording in tests).
import { z } from "zod";
import { tenantDay, toMicros, type CostLedger } from "./budget";
import type { DataClass, LlmConfig } from "./config";
import { routeFor, type LlmRefusal } from "./routing";
import type { Transport } from "./transport";

export type Message = { role: "system" | "user" | "assistant"; content: string };

export type GenerateRequest<S extends z.ZodType> = {
  role: string;
  dataClass: DataClass;
  tenantId: string;
  runId: string;
  messages: Message[];
  /** The answer's shape. Sent as a JSON Schema and checked on the way back. */
  schema: S;
  schemaName: string;
};

export type Usage = {
  promptTokens: number;
  completionTokens: number;
  micros: number;
  estimated: boolean;
};

export function createLlm(deps: {
  config: LlmConfig;
  transport: Transport;
  ledger: CostLedger;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());

  return {
    async generate<S extends z.ZodType>(
      req: GenerateRequest<S>,
    ): Promise<{ ok: true; value: z.output<S>; usage: Usage } | LlmRefusal> {
      const role = deps.config.roles[req.role];
      if (!role)
        return {
          ok: false,
          code: "NO_ROUTE",
          detail: `LLM-004: no role ${req.role} in the config`,
        };
      const provider = routeFor(deps.config, req.dataClass, role.model);
      if ("ok" in provider) return provider;

      // Pre-flight: an upper bound, since max_price caps what any endpoint may charge.
      const price = deps.config.prices[role.model]!;
      const promptChars = req.messages.reduce((n, m) => n + m.content.length, 0);
      const estimate = toMicros(
        Math.ceil(promptChars / 3) * price.prompt + role.maxTokens * price.completion,
      );
      const day = tenantDay(req.tenantId, now());
      const spent = await deps.ledger.spent(req.runId, day);
      const caps = deps.config.caps;
      if (spent.run + estimate > toMicros(caps.perRunUsd)) {
        return {
          ok: false,
          code: "OVER_BUDGET",
          detail: `LLM-005: run ${req.runId} would exceed $${caps.perRunUsd}`,
        };
      }
      if (spent.tenantDay + estimate > toMicros(caps.perTenantPerDayUsd)) {
        return {
          ok: false,
          code: "OVER_BUDGET",
          detail: `LLM-006: tenant would exceed $${caps.perTenantPerDayUsd} today`,
        };
      }

      const request = {
        model: role.model, // one model: no `models` fallback list, ever (ai.md)
        messages: req.messages,
        max_tokens: role.maxTokens,
        response_format: {
          type: "json_schema",
          json_schema: { name: req.schemaName, strict: true, schema: jsonSchema(req.schema) },
        },
        provider,
      };
      let res;
      try {
        res = await deps.transport(request);
      } catch (error) {
        if (String(error).includes("LLM-REC-001")) throw error; // a missing recording is a test defect
        return {
          ok: false,
          code: "UNAVAILABLE",
          detail: `LLM-007: OpenRouter unreachable: ${String(error)}`,
        };
      }
      if (res.status < 200 || res.status >= 300) {
        const message = (res.body as { error?: { message?: string } } | null)?.error?.message;
        // Never retried with a looser route: a 404 for "no endpoint matches" stays a refusal.
        return {
          ok: false,
          code: "UNAVAILABLE",
          detail: `LLM-008: OpenRouter ${res.status}: ${message ?? "no detail"}`,
        };
      }

      const body = res.body as {
        choices?: { message?: { content?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      };
      const cost = body.usage?.cost;
      const usage: Usage = {
        promptTokens: body.usage?.prompt_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
        micros: typeof cost === "number" ? toMicros(cost) : estimate,
        estimated: typeof cost !== "number", // priced by guess: say so rather than under-count
      };
      // Settle what was charged even if the answer is then rejected: it was spent.
      await deps.ledger.add({
        runId: req.runId,
        tenantDay: day,
        micros: usage.micros,
        estimated: usage.estimated,
      });

      const content = body.choices?.[0]?.message?.content;
      let json: unknown;
      try {
        json = JSON.parse(content ?? "");
      } catch {
        return { ok: false, code: "BAD_OUTPUT", detail: "LLM-009: the answer was not JSON" };
      }
      const parsed = req.schema.safeParse(json);
      if (!parsed.success) {
        return {
          ok: false,
          code: "BAD_OUTPUT",
          detail: `LLM-010: the answer failed its schema: ${parsed.error.issues[0]?.message}`,
        };
      }
      return { ok: true, value: parsed.data, usage };
    },
  };
}

/** The schema as JSON Schema, without the `$schema` dialect line (unneeded in a request body). */
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = { ...(z.toJSONSchema(schema) as Record<string, unknown>) };
  delete json.$schema;
  return json;
}

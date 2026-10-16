// The route a request takes, decided by its data class. Enforced here, per
// request, not left to account settings somebody can change (security.md).
import { DATA_CLASSES, type DataClass, type LlmConfig } from "./config";

export type LlmRefusal = {
  ok: false;
  /** NO_ROUTE: policy refuses this data on this model. OVER_BUDGET: a cap. UNAVAILABLE: could not ask. BAD_OUTPUT: the model's answer failed its schema. */
  code: "NO_ROUTE" | "OVER_BUDGET" | "UNAVAILABLE" | "BAD_OUTPUT";
  detail: string;
};

export type ProviderPreferences = {
  data_collection: "deny";
  zdr?: true;
  only?: string[];
  require_parameters: true;
  /** USD per million tokens (OpenRouter's unit). */
  max_price: { prompt: number; completion: number };
};

export function routeFor(
  config: LlmConfig,
  dataClass: DataClass | undefined,
  model: string,
): ProviderPreferences | LlmRefusal {
  if (!dataClass || !(DATA_CLASSES as readonly string[]).includes(dataClass)) {
    return {
      ok: false,
      code: "NO_ROUTE",
      detail: `LLM-001: a request must declare its data class (got ${String(dataClass)})`,
    };
  }
  const price = config.prices[model];
  if (!price)
    return { ok: false, code: "NO_ROUTE", detail: `LLM-003: no reviewed price for ${model}` };
  const base: ProviderPreferences = {
    // Every route: no provider that stores or trains on inputs.
    data_collection: "deny",
    // Only endpoints that honour every parameter sent (response_format above all).
    require_parameters: true,
    max_price: { prompt: price.prompt * 1e6, completion: price.completion * 1e6 },
  };
  if (dataClass === "synthetic") return base;
  if (!config.zdrModels.includes(model)) {
    return {
      ok: false,
      code: "NO_ROUTE",
      detail: `LLM-002: ${model} is not on the zero-data-retention allow-list, so it may not see ${dataClass} data`,
    };
  }
  return { ...base, zdr: true, ...(config.zdrProviders ? { only: [...config.zdrProviders] } : {}) };
}

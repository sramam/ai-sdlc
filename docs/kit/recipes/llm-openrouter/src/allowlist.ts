// Reviews the ZDR allow-list against OpenRouter's public list of Zero Data
// Retention endpoints (GET https://openrouter.ai/api/v1/endpoints/zdr, no key).
// Pure, so it is tested on a saved excerpt; `check-allowlist.mts` runs it live.
import type { LlmConfig } from "./config";

export type ZdrEndpoint = {
  model_id: string;
  provider_name: string;
  pricing: { prompt: string; completion: string };
  supported_parameters?: string[];
};

export type AllowListFinding =
  | { model: string; verdict: "ok"; providers: string[] }
  | { model: string; verdict: "no-zdr-endpoint" }
  | { model: string; verdict: "no-structured-output" }
  | {
      model: string;
      verdict: "price-above-config";
      highest: { prompt: number; completion: number };
    };

export function checkAllowList(endpoints: ZdrEndpoint[], config: LlmConfig): AllowListFinding[] {
  return config.zdrModels.map((model): AllowListFinding => {
    const mine = endpoints.filter((e) => e.model_id === model);
    if (!mine.length) return { model, verdict: "no-zdr-endpoint" };
    const structured = mine.filter((e) => e.supported_parameters?.includes("response_format"));
    if (!structured.length) return { model, verdict: "no-structured-output" };
    const highest = {
      prompt: Math.max(...structured.map((e) => Number(e.pricing.prompt))),
      completion: Math.max(...structured.map((e) => Number(e.pricing.completion))),
    };
    const p = config.prices[model];
    if (!p || highest.prompt > p.prompt || highest.completion > p.completion) {
      // Not wrong, but max_price would then exclude the dearer endpoints: decide.
      return { model, verdict: "price-above-config", highest };
    }
    return {
      model,
      verdict: "ok",
      providers: [...new Set(structured.map((e) => e.provider_name))].sort(),
    };
  });
}

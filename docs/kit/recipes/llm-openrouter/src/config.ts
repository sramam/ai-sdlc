// The project's model policy, reviewed like code (security.md § Model providers).
// Roles, not models, are what call sites name; changing a model is one line here.

/**
 * Who the data in a prompt is about. Decides the route; there is no default.
 * - synthetic: generated, public or already-anonymized (dev, evals, fixtures)
 * - personal:  about a real person (a user's own data)
 * - tenant:    a customer's business data (their records, their customers)
 */
export const DATA_CLASSES = ["synthetic", "personal", "tenant"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export type RoleConfig = {
  model: string;
  /** Upper bound on completion tokens; also what the pre-flight cost estimate assumes. */
  maxTokens: number;
};

/** Prices in USD per token, the shape OpenRouter publishes. Use the HIGHEST endpoint price. */
export type Price = { prompt: number; completion: number };

export type LlmConfig = {
  roles: Readonly<Record<string, RoleConfig>>;
  /**
   * Models allowed for personal and tenant data: each has Zero Data Retention
   * endpoints. Reviewed against GET /api/v1/endpoints/zdr (`checkAllowList`),
   * with the date of the review beside it.
   */
  zdrModels: readonly string[];
  zdrReviewed: string;
  /** Optional provider allow-list for personal/tenant routes (`provider.only`). */
  zdrProviders?: readonly string[];
  prices: Readonly<Record<string, Price>>;
  caps: { perRunUsd: number; perTenantPerDayUsd: number };
};

export const LLM_CONFIG: LlmConfig = {
  roles: {
    classify: { model: "google/gemini-3.5-flash-lite", maxTokens: 512 },
    draft: { model: "anthropic/claude-sonnet-5.5", maxTokens: 2048 },
    explore: { model: "openai/gpt-oss-120b", maxTokens: 1024 }, // synthetic data only (not on zdrModels)
  },
  zdrModels: ["google/gemini-3.5-flash-lite", "anthropic/claude-sonnet-5.5"],
  zdrReviewed: "2026-10-16",
  // Read 2026-10-16: the highest ZDR endpoint price for the ZDR models
  // (fixtures/zdr-endpoints.*.json), the /api/v1/models price for the other.
  // Sent as `provider.max_price`, so no route can cost more than the estimate.
  prices: {
    "google/gemini-3.5-flash-lite": { prompt: 0.00000054, completion: 0.0000045 },
    "anthropic/claude-sonnet-5.5": { prompt: 0.0000022, completion: 0.000011 },
    "openai/gpt-oss-120b": { prompt: 0.00000015, completion: 0.0000006 },
  },
  caps: { perRunUsd: 0.5, perTenantPerDayUsd: 5 },
};

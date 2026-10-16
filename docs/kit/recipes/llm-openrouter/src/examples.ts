// The requests the suite replays. A recording belongs to the exact request:
// change a prompt here and the suite fails until it is re-recorded.
import { z } from "zod";
import type { GenerateRequest } from "./llm";

export const Category = z.object({
  category: z.enum(["billing", "maintenance", "other"]),
  confidence: z.number().min(0).max(1),
});

export const classifySynthetic: GenerateRequest<typeof Category> = {
  role: "classify",
  dataClass: "synthetic",
  tenantId: "t-demo",
  runId: "run-1",
  schemaName: "category",
  schema: Category,
  messages: [
    { role: "system", content: "Classify the support message. Answer with the schema." },
    { role: "user", content: "The kitchen tap in unit 4B has been dripping since Monday." },
  ],
};

export const classifyTenant: GenerateRequest<typeof Category> = {
  ...classifySynthetic,
  dataClass: "tenant",
  tenantId: "t-acme",
  runId: "run-2",
};

// Recording, by hand: LLM_RECORD=1 OPENROUTER_API_KEY=… pnpm exec vitest run src/record.manual.test.ts
// Sends the example requests to OpenRouter for real and rewrites fixtures/cassette.json.
// Synthetic data only: a recording is committed, so a real person's data never goes in one.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { memoryLedger } from "./budget";
import { LLM_CONFIG } from "./config";
import { classifySynthetic } from "./examples";
import { createLlm } from "./llm";
import { recordingTransport, type Cassette } from "./recorded";
import { openRouterTransport } from "./transport";

const key = process.env.OPENROUTER_API_KEY;

describe.runIf(process.env.LLM_RECORD === "1" && key)("recording (manual)", () => {
  it("records the synthetic examples", async () => {
    const path = new URL("../fixtures/cassette.json", import.meta.url);
    // Merge: entries not re-recorded here (the deliberately off-schema one) are kept.
    const cassette = JSON.parse(readFileSync(path, "utf8")) as Cassette;
    const llm = createLlm({
      config: LLM_CONFIG,
      ledger: memoryLedger(),
      transport: recordingTransport(openRouterTransport({ apiKey: key! }), cassette),
    });
    for (const req of [classifySynthetic]) {
      expect(req.dataClass).toBe("synthetic");
      await llm.generate(req);
    }
    writeFileSync(
      path,
      JSON.stringify(
        { ...cassette, _source: `synthetic examples recorded ${new Date().toISOString()}` },
        null,
        2,
      ) + "\n",
    );
  });
});

/* eslint-disable no-console -- a CLI prints on purpose */
// Manual, never CI (it reaches the network): pnpm exec node src/check-allowlist.mts
// Prints one line per model on the allow-list; exits 1 on anything but ok.
import { checkAllowList, type ZdrEndpoint } from "./allowlist.ts";
import { LLM_CONFIG } from "./config.ts";

const res = await fetch("https://openrouter.ai/api/v1/endpoints/zdr", {
  signal: AbortSignal.timeout(10_000),
});
if (!res.ok) {
  console.error(`could not ask: GET /endpoints/zdr answered ${res.status}`);
  process.exit(2);
}
const { data } = (await res.json()) as { data: ZdrEndpoint[] };
const findings = checkAllowList(data, LLM_CONFIG);
for (const f of findings)
  console.log(
    `${f.verdict.padEnd(22)} ${f.model} ${JSON.stringify("providers" in f ? f.providers : "highest" in f ? f.highest : "")}`,
  );
console.log(`allow-list last reviewed ${LLM_CONFIG.zdrReviewed}`);
process.exit(findings.every((f) => f.verdict === "ok") ? 0 : 1);

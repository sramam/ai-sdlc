// The unit suite never reaches the network: fetch is replaced with a function
// that fails the test, and every model answer comes from fixtures/cassette.json.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkAllowList, type ZdrEndpoint } from "./allowlist";
import { memoryLedger, toMicros } from "./budget";
import { LLM_CONFIG, type LlmConfig } from "./config";
import { classifySynthetic, classifyTenant } from "./examples";
import { createLlm } from "./llm";
import { recordedTransport, requestKey, type Cassette } from "./recorded";
import type { ChatRequest, Transport } from "./transport";

const fixture = (f: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8"));
const cassette = fixture("cassette.json") as Cassette;

beforeAll(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("the unit suite may not reach the network");
  });
});
afterAll(() => vi.unstubAllGlobals());

/** Records what was sent, and answers from the cassette. */
function spy(inner: Transport = recordedTransport(cassette)) {
  const sent: ChatRequest[] = [];
  const t: Transport = (r) => (sent.push(r), inner(r));
  return { t, sent };
}

describe("routing by data class", () => {
  it("synthetic data: data collection denied, no ZDR requirement, one model, structured output", async () => {
    const { t, sent } = spy();
    const r = await createLlm({
      config: LLM_CONFIG,
      transport: t,
      ledger: memoryLedger(),
    }).generate(classifySynthetic);
    expect(r).toMatchObject({ ok: true, value: { category: "maintenance" } });
    const req = sent[0]!;
    expect(req.provider).toEqual({
      data_collection: "deny",
      require_parameters: true,
      max_price: { prompt: 0.54, completion: 4.5 },
    });
    expect(req).not.toHaveProperty("models"); // no fallback to another model
    expect(req.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { strict: true },
    });
  });

  it("tenant data: only zero-data-retention endpoints", async () => {
    const { t, sent } = spy();
    await createLlm({ config: LLM_CONFIG, transport: t, ledger: memoryLedger() }).generate(
      classifyTenant,
    );
    expect(sent[0]!.provider).toMatchObject({ data_collection: "deny", zdr: true });
  });

  it("an allow-list of providers is sent as `only`", async () => {
    const config: LlmConfig = { ...LLM_CONFIG, zdrProviders: ["Google"] };
    const sent: ChatRequest[] = [];
    await createLlm({
      config,
      transport: async (r) => (sent.push(r), { status: 503, body: null }),
      ledger: memoryLedger(),
    }).generate(classifyTenant);
    expect(sent[0]!.provider).toMatchObject({ zdr: true, only: ["Google"] });
  });

  it("personal or tenant data on a model off the ZDR allow-list is refused before any call", async () => {
    const { t, sent } = spy();
    const llm = createLlm({ config: LLM_CONFIG, transport: t, ledger: memoryLedger() });
    for (const dataClass of ["personal", "tenant"] as const) {
      expect(
        await llm.generate({ ...classifySynthetic, role: "explore", dataClass }),
      ).toMatchObject({
        ok: false,
        code: "NO_ROUTE",
        detail: expect.stringContaining("LLM-002"),
      });
    }
    expect(sent).toEqual([]);
  });

  it("a request without a data class is refused (LLM-001), whatever the type system was told", async () => {
    const { t, sent } = spy();
    const r = await createLlm({
      config: LLM_CONFIG,
      transport: t,
      ledger: memoryLedger(),
    }).generate({
      ...classifySynthetic,
      dataClass: undefined as never,
    });
    expect(r).toMatchObject({
      ok: false,
      code: "NO_ROUTE",
      detail: expect.stringContaining("LLM-001"),
    });
    expect(sent).toEqual([]);
  });
});

describe("output is untrusted input", () => {
  it("an answer that fails its schema is BAD_OUTPUT, and its cost is still counted", async () => {
    const ledger = memoryLedger();
    // The tenant recording answers "plumbing", which is not a category.
    const r = await createLlm({
      config: LLM_CONFIG,
      transport: recordedTransport(cassette),
      ledger,
    }).generate(classifyTenant);
    expect(r).toMatchObject({ ok: false, code: "BAD_OUTPUT" });
    expect(ledger.entries).toHaveLength(1);
  });

  it("an answer that is not JSON is BAD_OUTPUT", async () => {
    const r = await createLlm({
      config: LLM_CONFIG,
      ledger: memoryLedger(),
      transport: async () => ({
        status: 200,
        body: { choices: [{ message: { content: "Sure! Maintenance." } }] },
      }),
    }).generate(classifySynthetic);
    expect(r).toMatchObject({ ok: false, code: "BAD_OUTPUT" });
  });

  it("a non-2xx answer is UNAVAILABLE and is not retried on a looser route", async () => {
    const { t, sent } = spy(async () => ({
      status: 404,
      body: { error: { message: "No endpoints found" } },
    }));
    const r = await createLlm({
      config: LLM_CONFIG,
      transport: t,
      ledger: memoryLedger(),
    }).generate(classifyTenant);
    expect(r).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    expect(sent).toHaveLength(1);
  });
});

describe("cost caps, in process", () => {
  it("settles the reported cost, or the estimate marked as estimated", async () => {
    const ledger = memoryLedger();
    const llm = createLlm({ config: LLM_CONFIG, transport: recordedTransport(cassette), ledger });
    const r = await llm.generate(classifySynthetic);
    expect(r).toMatchObject({ ok: true, usage: { micros: toMicros(0.0000841), estimated: false } });
    const noCost = createLlm({
      config: LLM_CONFIG,
      ledger,
      transport: async () => ({
        status: 200,
        body: { choices: [{ message: { content: '{"category":"other","confidence":0.5}' } }] },
      }),
    });
    expect(await noCost.generate(classifySynthetic)).toMatchObject({
      ok: true,
      usage: { estimated: true },
    });
  });

  it("refuses before the call when the run, or the tenant's day, would exceed its cap", async () => {
    const config: LlmConfig = {
      ...LLM_CONFIG,
      caps: { perRunUsd: 0.01, perTenantPerDayUsd: 0.02 },
    };
    const ledger = memoryLedger();
    const { t, sent } = spy(async () => ({
      status: 200,
      body: {
        choices: [{ message: { content: '{"category":"other","confidence":1}' } }],
        usage: { cost: 0.009 },
      },
    }));
    let clock = new Date("2026-10-16T10:00:00Z");
    const llm = createLlm({ config, transport: t, ledger, now: () => clock });
    expect(await llm.generate(classifySynthetic)).toMatchObject({ ok: true });
    expect(await llm.generate(classifySynthetic)).toMatchObject({
      code: "OVER_BUDGET",
      detail: expect.stringContaining("LLM-005"),
    });
    expect(await llm.generate({ ...classifySynthetic, runId: "run-b" })).toMatchObject({
      ok: true,
    });
    expect(await llm.generate({ ...classifySynthetic, runId: "run-c" })).toMatchObject({
      code: "OVER_BUDGET",
      detail: expect.stringContaining("LLM-006"),
    });
    expect(sent).toHaveLength(2);
    clock = new Date("2026-10-17T00:00:01Z"); // a new UTC day
    expect(await llm.generate({ ...classifySynthetic, runId: "run-d" })).toMatchObject({
      ok: true,
    });
  });
});

describe("recordings", () => {
  it("a request with no recording throws, naming its key, rather than calling out", async () => {
    const llm = createLlm({
      config: LLM_CONFIG,
      transport: recordedTransport(cassette),
      ledger: memoryLedger(),
    });
    const changed = {
      ...classifySynthetic,
      messages: [{ role: "user" as const, content: "different" }],
    };
    await expect(llm.generate(changed)).rejects.toThrow(/LLM-REC-001/);
  });

  it("the key ignores property order", () => {
    expect(requestKey({ a: 1, b: { c: 2, d: 3 } })).toBe(requestKey({ b: { d: 3, c: 2 }, a: 1 }));
  });
});

describe("the ZDR allow-list review", () => {
  const endpoints = fixture("zdr-endpoints.2026-10-16.json").data as ZdrEndpoint[];
  it("every allow-listed model had a ZDR endpoint supporting structured output on the day it was read", () => {
    expect(checkAllowList(endpoints, LLM_CONFIG).map((f) => f.verdict)).toEqual(["ok", "ok"]);
  });
  it("a model with no ZDR endpoint, or a price above the config, is reported", () => {
    const config: LlmConfig = {
      ...LLM_CONFIG,
      zdrModels: ["openai/gpt-oss-120b", "anthropic/claude-sonnet-5.5"],
      prices: {
        ...LLM_CONFIG.prices,
        "anthropic/claude-sonnet-5.5": { prompt: 0.000002, completion: 0.00001 },
      },
    };
    expect(checkAllowList(endpoints, config).map((f) => f.verdict)).toEqual([
      "no-zdr-endpoint",
      "price-above-config",
    ]);
  });
});

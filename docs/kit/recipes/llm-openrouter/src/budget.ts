// Cost caps, enforced in-process before the call (OpenRouter's billing reports
// what was spent; it cannot stop a run part-way). Amounts are integer
// micro-dollars, so sums do not drift.
export type Micros = number;
export const toMicros = (usd: number): Micros => Math.ceil(usd * 1e6);

export interface CostLedger {
  /** Spent so far by this run, and by this tenant on this UTC day. */
  spent(runId: string, tenantDay: string): Promise<{ run: Micros; tenantDay: Micros }>;
  /** Record a settled cost. `estimated` when the response carried no cost. */
  add(entry: {
    runId: string;
    tenantDay: string;
    micros: Micros;
    estimated: boolean;
  }): Promise<void>;
}

/**
 * For tests and single-isolate dev. A deployed Worker needs a shared ledger:
 * a Durable Object per tenant, or a table (one row per call, summed).
 */
export function memoryLedger(): CostLedger & {
  entries: { runId: string; tenantDay: string; micros: Micros; estimated: boolean }[];
} {
  const entries: { runId: string; tenantDay: string; micros: Micros; estimated: boolean }[] = [];
  return {
    entries,
    async spent(runId, tenantDay) {
      let run = 0;
      let day = 0;
      for (const e of entries) {
        if (e.runId === runId) run += e.micros;
        if (e.tenantDay === tenantDay) day += e.micros;
      }
      return { run, tenantDay: day };
    },
    async add(entry) {
      entries.push(entry);
    },
  };
}

export const tenantDay = (tenantId: string, now: Date) =>
  `${tenantId}:${now.toISOString().slice(0, 10)}`;

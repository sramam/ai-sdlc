// KPI tiles: a compact number, the exact value on hover, and a link to the list
// behind it (ux.md). Compact formatting is for tiles only, never a table cell.
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat("en-US");
const compactUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});
const exactUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export type Kpi = {
  label: string;
  /** A count, or money as integer cents (never a float of dollars). */
  value: number;
  kind: "count" | "cents";
  /** The list this number summarises. */
  href: string;
};

export function formatKpi(k: Pick<Kpi, "value" | "kind">) {
  return k.kind === "cents"
    ? { short: compactUsd.format(k.value / 100), full: exactUsd.format(k.value / 100) }
    : { short: compact.format(k.value), full: exact.format(k.value) };
}

export function KpiTiles({ kpis }: { kpis: Kpi[] }) {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {kpis.map((k) => {
        const f = formatKpi(k);
        return (
          <a
            key={k.label}
            href={k.href}
            className="rounded-xl focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <Card size="sm">
              <CardHeader>
                <CardDescription>{k.label}</CardDescription>
                <CardTitle className="text-2xl tabular-nums" title={f.full}>
                  {f.short}
                </CardTitle>
              </CardHeader>
            </Card>
          </a>
        );
      })}
    </div>
  );
}

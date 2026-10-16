// The bindings pattern check (principles.md §6): every capability in the
// manifest is reachable through the HTTP API (and its OpenAPI document), MCP
// and the SDK, unless the manifest's `exclusions` names that binding for it
// with a reason.
//
// It reads what each binding ACTUALLY renders, not the declaration: the router
// is asked by request, the MCP tool list by `tools/list`, the SDK by sending
// its own request through the router. The surfaces are collected by the test;
// this module only compares, so tripping it needs no real binding.
import type { Binding, Exclusions } from "./surface";
import { BINDINGS } from "./surface";

/** What a rendering offers, by capability name. `openapi` is the HTTP binding's document. */
export type Surfaces = Readonly<Record<Binding | "openapi", ReadonlySet<string>>>;

export type Row = { capability: string } & Record<Binding | "openapi", string>;

const MIN_REASON_WORDS = 4;

export function checkBindings(
  names: readonly string[],
  exclusions: Exclusions,
  surfaces: Surfaces,
): { rows: Row[]; problems: string[] } {
  const problems: string[] = [];
  const known = new Set(names);

  for (const [name, ex] of Object.entries(exclusions)) {
    if (!known.has(name))
      problems.push(`${name}: excluded, but no such capability (delete the line)`);
    for (const [binding, reason] of Object.entries(ex ?? {})) {
      if (!(BINDINGS as readonly string[]).includes(binding))
        problems.push(`${name}: excluded from "${binding}", which is not a binding`);
      if ((reason ?? "").trim().split(/\s+/).filter(Boolean).length < MIN_REASON_WORDS)
        problems.push(
          `${name}: the ${binding} exclusion needs a reason (${MIN_REASON_WORDS}+ words)`,
        );
    }
    if (ex?.http && !ex.sdk)
      problems.push(`${name}: excluded from http, so from sdk too (the SDK calls HTTP)`);
  }

  const rows: Row[] = [];
  for (const name of names) {
    const row = { capability: name } as Row;
    for (const b of [...BINDINGS, "openapi"] as const) {
      const declared = exclusions[name]?.[b === "openapi" ? "http" : b];
      const offered = surfaces[b].has(name);
      if (!declared && !offered)
        problems.push(`${name}: missing from ${b}, and no exclusion says why`);
      if (declared && offered) problems.push(`${name}: excluded from ${b}, but ${b} offers it`);
      row[b] = offered ? "yes" : declared ? `excluded: ${declared}` : "MISSING";
    }
    rows.push(row);
  }
  for (const b of [...BINDINGS, "openapi"] as const) {
    for (const n of surfaces[b])
      if (!known.has(n))
        problems.push(`${n}: ${b} offers it, but the manifest has no such capability`);
  }
  return { rows, problems };
}

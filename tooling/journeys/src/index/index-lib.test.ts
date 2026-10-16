import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { readIndex, renderIndex, renderPointer, republish } from "./index-lib.mts";
import type { Registry } from "../registry.mts";

const registry: Registry = {
  journeys: [
    { id: "J1", title: "Browsing", personas: ["visitor"] },
    { id: "J2", title: "Paying", personas: ["visitor"] },
    { id: "J3", title: "Leaving", personas: ["visitor"] },
  ],
  personas: { visitor: { label: "A visitor" } },
};

function evidence(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "journeys-index-")));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

const walk = (folder: string, persona: string, readme: string) => ({
  [`${folder}/${persona}/persona.json`]: JSON.stringify({ key: persona, label: `the ${persona}` }),
  [`${folder}/${persona}/happy/README.md`]: readme,
  [`${folder}/${persona}/happy/run.json`]: JSON.stringify({
    steps: 1,
    ms: 1500,
    recordedAt: "2026-10-15T10:00:00Z",
  }),
});

describe("the evidence index", () => {
  const root = evidence({
    ...walk("J1-browsing", "visitor", "## 1. a\n"),
    ...walk("J2-paying", "visitor", "## 1. a\n**failed here**\n"),
    ...walk("J9-old-name", "visitor", "## 1. a\n"),
    "ready-for-qa.md":
      "# Signed off\n\n- [J1 Browsing](J1-browsing/README.md) — 2026-10-15\n- J2\n",
  });
  const state = readIndex(root, registry);

  it("needs green and a sign-off to be QA's — a sign-off does not override red", () => {
    expect(state.ready.map((r) => r.id)).toEqual(["J1"]);
    expect(state.testing.map((r) => r.id).sort()).toEqual(["J2", "J9"]);
    expect(state.notStarted).toEqual([{ id: "J3", title: "Leaving" }]);
  });

  it("names a folder the registry does not declare", () => {
    expect(state.undeclared).toEqual(["J9-old-name"]);
    expect(renderIndex(state, registry.journeys.length)).toContain("- `J9-old-name`");
  });

  it("renders the counts and the walks", () => {
    const page = renderIndex(state, 3);
    expect(page).toContain("**1 of 3 journeys ready for QA** — 2 in dev testing, 1 not started.");
    expect(page).toContain("| `visitor` | 3 | 3 | 3 |");
    expect(page).toContain("[visitor/happy](J2-paying/visitor/happy/README.md) ⚠");
  });

  it("writes a pointer per journey, one row per walk", () => {
    const pointer = renderPointer(state.ready[0]!, true);
    expect(pointer).toContain("**Dev Tested — ready for QA.**");
    expect(pointer).toContain(
      "| **the visitor** | 1 | 2026-10-15 | [read the walk](visitor/README.md) |",
    );
  });

  it("republishes a status line two levels down, and leaves a page with none alone", () => {
    const page = "# J1\n\n**In Dev Testing — not ready for QA.** old\n\nrest\n";
    const out = republish(page, { failingPaths: [], totalPaths: 1, signedOff: true });
    expect(out.recognised).toBe(true);
    expect(out.page).toContain("[ready-for-qa.md](../../ready-for-qa.md)");
    expect(
      republish("# not a journey page\n", { failingPaths: [], totalPaths: 1, signedOff: true }),
    ).toEqual({
      page: "# not a journey page\n",
      recognised: false,
    });
  });
});

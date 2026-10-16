/**
 * The project's pattern check over its own journeys (`tooling/journeys/src/pattern-check/`):
 * every screenshot is named by its narrative, every evidence folder belongs to a
 * registered journey at its current title, every recording sits under a persona
 * the journey declares, one spec per walk named for it, and every spec resets
 * the stack first. Each check reports what it counted; a finding fails its test.
 */
import { expect, it } from "vitest";
import { journeysRoot, loadJourneysConfig } from "../tooling/journeys/src/config.mts";
import { journeyPatternCheck } from "../tooling/journeys/src/pattern-check/pattern-check.mts";

const root = journeysRoot();
const report = journeyPatternCheck(root, await loadJourneysConfig(root));

for (const [name, check] of Object.entries(report)) {
  it(`${name} (${check.checked} checked)`, () => expect(check.findings).toEqual([]));
}

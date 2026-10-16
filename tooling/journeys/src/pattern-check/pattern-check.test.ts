import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import {
  directoryPatternCheck,
  isolationPatternCheck,
  personaPatternCheck,
  snapshotPatternCheck,
  specPatternCheck,
} from "./pattern-check.mts";
import type { Registry } from "../registry.mts";

const registry: Registry = {
  journeys: [{ id: "J4", title: "Signing In", personas: ["organizer"] }],
  personas: { organizer: { label: "An organizer" }, attendee: { label: "An attendee" } },
};

const tiny = PNG.sync.write(new PNG({ width: 2, height: 2 }));

/** A tree with one of everything a pattern check should and should not say. */
function tree(files: Record<string, string | Buffer>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "journeys-pattern-check-")));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

const walk = (persona: string, extra: Record<string, string | Buffer> = {}) => ({
  [`J4-signing-in/${persona}/persona.json`]: JSON.stringify({ key: persona, label: "x" }),
  [`J4-signing-in/${persona}/happy/README.md`]: "## 1. Open\n\n![Open](snapshots/01-open.png)\n",
  [`J4-signing-in/${persona}/happy/diff.md`]: "![m](snapshots/01-open-mask.png)\n",
  [`J4-signing-in/${persona}/happy/snapshots/01-open.png`]: tiny,
  [`J4-signing-in/${persona}/happy/snapshots/01-open-mask.png`]: tiny,
  [`J4-signing-in/${persona}/happy/snapshots/01-open.png.mask.json`]: "{}",
  ...extra,
});

describe("the snapshot pattern check", () => {
  it("finds nothing wrong with a clean recording, and says it checked something", () => {
    expect(snapshotPatternCheck(tree(walk("common")))).toEqual({ checked: 1, findings: [] });
  });

  it("names an orphan with its siblings, a missing image and a dangling mask", () => {
    const root = tree(
      walk("common", {
        "J4-signing-in/common/happy/snapshots/02-old.png": tiny,
        "J4-signing-in/common/happy/snapshots/02-old.png.mask.json": "{}",
        "J4-signing-in/common/happy/snapshots/03-gone.png.mask.json": "{}",
        "J4-signing-in/common/happy/diff.md":
          "![m](snapshots/01-open-mask.png) ![x](snapshots/09-missing.png)\n",
      }),
    );
    const { findings } = snapshotPatternCheck(root);
    expect(findings).toEqual([
      "orphan screenshot J4-signing-in/common/happy/02-old.png (also: 02-old.png.mask.json)",
      "J4-signing-in/common/happy: names 09-missing.png, which is not on disk",
      "J4-signing-in/common/happy: mask 03-gone.png.mask.json has no screenshot",
    ]);
  });

  it("ratchets known orphans in both directions", () => {
    const root = tree(walk("common", { "J4-signing-in/common/happy/snapshots/02-old.png": tiny }));
    expect(
      snapshotPatternCheck(root, { knownOrphans: ["J4-signing-in/common/happy/02-old.png"] })
        .findings,
    ).toEqual([]);
    expect(
      snapshotPatternCheck(tree(walk("common")), {
        knownOrphans: ["J4-signing-in/common/happy/02-old.png"],
      }).findings[0],
    ).toMatch(/no longer an orphan/);
  });
});

describe("the directory and persona pattern checks", () => {
  it("names a folder left behind by a rename", () => {
    const root = tree({ ...walk("common"), "J4-sign-in/common/happy/README.md": "" });
    expect(directoryPatternCheck(root, registry).findings).toEqual([
      "J4-sign-in — J4 is registered as `J4-signing-in`, so this is the old name",
    ]);
  });

  it("names a path with no persona level, an undeclared walk and a marker that disagrees", () => {
    const root = tree({
      ...walk("organizer"),
      ...walk("attendee"),
      "J4-signing-in/legacy/README.md": "## 1. x\n",
      "J4-signing-in/organizer/persona.json": JSON.stringify({ key: "attendee", label: "x" }),
    });
    expect(personaPatternCheck(root, registry).findings).toEqual([
      'J4-signing-in/attendee/happy — J4 does not list persona "attendee"',
      "J4-signing-in/legacy — a path with no persona level; record it under <journey>/<persona>/",
      'J4-signing-in/organizer/persona.json says key "attendee", not "organizer"',
    ]);
  });
});

describe("the spec and isolation pattern checks", () => {
  const spec = (persona: string, reset = "test.beforeAll(resetJourneyStack);") =>
    `import x from "y";\n${reset}\ntest("t", async () => { await Journey.open(page, { persona: "${persona}" }); });\n`;

  it("requires the persona in the name to be the persona recorded", () => {
    const root = tree({
      "j4-signing-in.organizer.spec.ts": spec("organizer"),
      "j4-signing-in.common.spec.ts": spec("organizer"),
      "j4-signing-in.ghost.spec.ts": spec("ghost"),
      "signing-in.spec.ts": spec("organizer"),
      "fixtures.spec.ts": "test('no journey', () => {});\n",
    });
    expect(specPatternCheck(root, registry).findings).toEqual([
      'j4-signing-in.common.spec.ts — named for "common" and records persona "organizer"',
      'j4-signing-in.ghost.spec.ts — "ghost" is not a persona in the registry',
      "signing-in.spec.ts — records a journey, so it is named <id>-<slug>.<persona>.spec.ts",
    ]);
  });

  it("requires a reset before the first test, read from code rather than comments", () => {
    const root = tree({
      "a.spec.ts": spec("common"),
      "b.spec.ts": spec(
        "common",
        "test.beforeAll(async () => {\n  await resetJourneyStack();\n  await build();\n});",
      ),
      "c.spec.ts": spec(
        "common",
        "test.beforeAll(async () => {\n  await build();\n  await resetJourneyStack();\n});",
      ),
      "d.spec.ts": spec("common", "/* test.beforeAll(resetJourneyStack); */"),
    });
    expect(isolationPatternCheck(root)).toEqual({
      checked: 4,
      findings: [
        "c.spec.ts — does not call test.beforeAll(resetJourneyStack); before its first test",
        "d.spec.ts — does not call test.beforeAll(resetJourneyStack); before its first test",
      ],
    });
  });
});

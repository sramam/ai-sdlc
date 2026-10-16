/**
 * **The whole machine, against a real browser**: a fixture app behind a fake
 * `StackAdapter`, the real `journeys learn` (three passes over one stack), a
 * deliberate pixel change, and the delta's verdicts.
 *
 * Skipped — with the reason printed — where Chromium is not installed for this
 * package's Playwright (`pnpm exec playwright install chromium`). Everything
 * else in the package is unit-tested without a browser.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeProject } from "./__fixtures__/app/project.mts";
import { portIsFree } from "./stack/ports.mts";

const CLI = fileURLToPath(new URL("./cli/journeys.mts", import.meta.url));

/** Is Chromium installed for the Playwright this package resolves? Asked in a child, so vitest never loads Playwright. */
function chromiumMissing(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("@playwright/test");
    const probe = spawnSync(
      process.execPath,
      ["-e", `console.log(require(${JSON.stringify(pkg)}).chromium.executablePath())`],
      { encoding: "utf8" },
    );
    const path = probe.stdout.trim();
    return path && existsSync(path)
      ? null
      : `Chromium is not installed (${path || probe.stderr.trim()})`;
  } catch (error) {
    return `@playwright/test is not resolvable: ${String(error)}`;
  }
}

const missing = chromiumMissing();
if (missing)
  console.warn(`\n  e2e skipped: ${missing}. Run \`pnpm exec playwright install chromium\`.\n`);

/**
 * Ports of this test's own, well outside the derived band. Derived ports are
 * right for a checkout and wrong here: other test files bind ports in that band
 * concurrently, and a stack that loses its port to a neighbour fails for a
 * reason that has nothing to do with what is under test.
 */
async function freePorts(): Promise<{ app: number; db: number }> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const app = randomInt(40_000, 60_000);
    if ((await portIsFree(app)) && (await portIsFree(app + 10)) && (await portIsFree(app + 11))) {
      return { app, db: app + 10 };
    }
  }
  throw new Error("no free ports between 40000 and 60000");
}

let ports = { app: 0, db: 0 };

/** The environment a CLI runs under: this test's ports, and none of this process's learning flags. */
function env(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env, JOURNEY_LOAD_OVERRIDE: "the journeys e2e test" };
  for (const name of Object.keys(out)) {
    if (name.startsWith("JOURNEY_") && name !== "JOURNEY_LOAD_OVERRIDE") delete out[name];
  }
  out.JOURNEY_APP_PORT = String(ports.app);
  out.JOURNEY_DB_PORT = String(ports.db);
  delete out.VITEST;
  delete out.TEST_WORKER_INDEX;
  return out;
}

const run = (root: string, ...args: string[]) => {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    env: env(),
    encoding: "utf8",
  });
  return { status: result.status ?? 1, output: `${result.stdout}\n${result.stderr}` };
};

const commit = (root: string, message: string) => {
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "--no-verify", "-m", message], { cwd: root });
};

describe.skipIf(missing !== null)("journeys, end to end against the fixture app", () => {
  let root = "";
  const path = () => join(root, "docs/journeys/J1-fixture-walk/common/happy");

  beforeAll(async () => {
    root = makeProject();
    ports = await freePorts();
  });
  afterAll(() => {
    // Left on disk for inspection when something failed; it lives under the OS temp directory.
  });

  it("learns three passes and gates every step", { timeout: 300_000 }, () => {
    const learn = run(root, "learn", "--journey", "J1");
    expect(learn.status, learn.output).toBe(0);
    expect(learn.output).toContain("4 of 4 steps have a mask");
    expect(learn.output).toContain("Every recorded step is now compared");

    const readme = readFileSync(join(path(), "README.md"), "utf8");
    expect(readme).toContain("## 3. Ask for the welcome email");
    expect(readme).not.toContain("**failed here**");
    const stamp = JSON.parse(readFileSync(join(path(), "run.json"), "utf8")) as {
      visited: string[];
      stack: string;
    };
    expect(stamp.visited).toEqual(["/", "/clock", "/welcome-email"]);
    expect(stamp.stack).toBe("fixture http");

    const clock = JSON.parse(
      readFileSync(join(path(), "snapshots/02-read-the-time.png.mask.json"), "utf8"),
    ) as { boxes: Array<{ provenance: string; from: string }> };
    expect(
      clock.boxes.some(
        (b) => b.provenance === "declared" && b.from.includes("data-volatile-clock"),
      ),
    ).toBe(true);
    commit(root, "record J1");
  });

  it(
    "passes a single comparison run, and writes nothing it did not change",
    { timeout: 120_000 },
    () => {
      const test = run(root, "test", "--journey", "J1");
      expect(test.status, test.output).toBe(0);
      const dirty = execFileSync("git", ["status", "--porcelain", "--", "docs/journeys"], {
        cwd: root,
        encoding: "utf8",
      })
        .split("\n")
        .filter((l) => l.trim() && !/run\.json|README\.md|diff\.md/.test(l));
      expect(dirty, "a passing comparison keeps the committed pixels and masks").toEqual([]);
    },
  );

  it("fails a comparison run when a page changes outside its mask", { timeout: 120_000 }, () => {
    writeFileSync(join(root, "fixture-title.txt"), "Welcome back, visitor\n");
    const test = run(root, "test", "--journey", "J1");
    expect(test.status, test.output).toBe(1);
    expect(test.output).toContain("01-open-the-home-page.png changed outside its mask");
    const readme = readFileSync(join(path(), "README.md"), "utf8");
    expect(readme).toContain("This step changed");
    expect(existsSync(join(path(), "snapshots/changed/01-open-the-home-page-diff.png"))).toBe(true);
    // The steps that did not change are still green.
    expect(test.output).not.toContain("02-read-the-time.png changed");
  });

  it("reports a deliberate pixel change as changed, and held", { timeout: 300_000 }, () => {
    const learn = run(root, "learn", "--journey", "J1");
    expect(learn.status, learn.output).toBe(0);

    const delta = readFileSync(join(root, "test-results/journey-reports/delta.md"), "utf8");
    const row = delta
      .split("\n")
      .find((l) => l.includes("01-open-the-home-page.png") && l.startsWith("| ["));
    expect(row, delta).toBeDefined();
    expect(row).toContain("changed");
    expect(row).toContain("held");
    expect(delta).toContain("Every step held on its last comparison.");
    // The steps that did not change are not in "What moved".
    expect(delta).not.toMatch(/\| \[common\/happy\/02-read-the-time\.png\]/);
    // Relearning cleared the red comparison's evidence.
    expect(existsSync(join(path(), "snapshots/changed"))).toBe(false);
    commit(root, "re-record J1 after the title change");
  });

  it(
    "flags a mask that grew on an identical screenshot as spurious, and fails",
    { timeout: 60_000 },
    () => {
      const file = join(path(), "snapshots/01-open-the-home-page.png.mask.json");
      const mask = JSON.parse(readFileSync(file, "utf8")) as { version: number; boxes: unknown[] };
      mask.boxes.push({
        x: 0,
        y: 0,
        width: 600,
        height: 300,
        from: "div.card[0]",
        provenance: "learned",
      });
      writeFileSync(file, JSON.stringify(mask, null, 2) + "\n");

      const delta = run(root, "delta");
      expect(delta.status, delta.output).toBe(1);
      expect(delta.output).toContain("**spurious**");
      expect(delta.output).toContain(
        `git checkout HEAD -- "docs/journeys/J1-fixture-walk/common/happy/snapshots/01-open-the-home-page.png.mask.json"`,
      );
    },
  );

  it(
    "finds no orphan, stray folder or unnamed walk in what it recorded",
    { timeout: 60_000 },
    async () => {
      const { loadJourneysConfig } = await import("./config.mts");
      const { journeyCensus } = await import("./census/census.mts");
      const report = journeyCensus(root, await loadJourneysConfig(root));
      for (const [name, census] of Object.entries(report)) {
        expect(census.findings, name).toEqual([]);
        expect(census.checked, `${name} checked nothing`).toBeGreaterThan(0);
      }
    },
  );
});

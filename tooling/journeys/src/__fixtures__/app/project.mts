/**
 * Lay out a throwaway project around the fixture app: a checkout marker, a
 * `journeys.config.mts`, a Playwright config, one spec, and a git repository —
 * so a test can run the real CLIs against it exactly as a project would.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE as SDLC_CONFIG } from "../../../../core/src/config.mts";

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const at = (path: string) => JSON.stringify(join(SRC, path));

export const FIXTURE_REGISTRY = {
  journeys: [{ id: "J1", title: "Fixture walk", personas: ["visitor"] }],
  personas: { visitor: { label: "A visitor to the fixture" } },
};

export function spec(): string {
  return `import { readFileSync } from "node:fs";
import { expect, resetJourneyStack, test } from ${at("playwright/fixtures.mts")};
import { Journey } from ${at("recorder/journey.mts")};
import { lastCaptured } from ${at("outbox.mts")};

test.beforeAll(resetJourneyStack);

test.describe("J1 Fixture walk", () => {
  test("happy", async ({ page }) => {
    const journey = await Journey.open(page, {
      id: "J1",
      title: "Fixture walk",
      path: "happy",
      intent: "see the home page, the time, and a welcome email",
      persona: "common",
    });
    await journey.step("Open the home page", "The heading greets the visitor.", async () => {
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    });
    await journey.step("Read the time", "A clock that differs on every run, masked by declaration.", async () => {
      await page.getByRole("link", { name: "See the time" }).click();
      await expect(page.locator("[data-volatile-clock]")).toBeVisible();
    });
    await journey.step("Ask for the welcome email", "The app captures the message rather than sending it.", async () => {
      await page.goto("/welcome-email");
      await expect(page.getByRole("heading", { name: "Sent" })).toBeVisible();
      const message = lastCaptured("visitor@example.test", /Welcome/);
      return [Journey.rendered("The welcome email", readFileSync(message.htmlPath, "utf8"))];
    });
  });
});
`;
}

/** A fresh project directory, committed once so `git show HEAD:` has something to say. */
export function makeProject(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "journeys-e2e-")));
  // The marker `findRoot` walks up to — core's name for it, not a copy of the name.
  writeFileSync(join(root, SDLC_CONFIG), "{}\n");
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  writeFileSync(join(root, "fixture-title.txt"), "Welcome\n");
  writeFileSync(join(root, ".gitignore"), "test-results/\n");
  writeFileSync(
    join(root, "journeys.config.mts"),
    `export default ${JSON.stringify(
      {
        adapter: join(SRC, "__fixtures__/app/adapter.mts"),
        playwrightConfig: "playwright.config.mts",
        registry: FIXTURE_REGISTRY,
      },
      null,
      2,
    )};\n`,
  );
  writeFileSync(
    join(root, "playwright.config.mts"),
    `import { defineJourneyPlaywrightConfig } from ${at("playwright/config.mts")};
import journeys from "./journeys.config.mts";
export default defineJourneyPlaywrightConfig({ journeys, root: ${JSON.stringify(root)} });
`,
  );
  mkdirSync(join(root, "e2e"));
  writeFileSync(join(root, "e2e", "j1-fixture-walk.common.spec.mts"), spec());
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.test");
  git("config", "user.name", "Fixture");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture project", "--no-verify");
  return root;
}

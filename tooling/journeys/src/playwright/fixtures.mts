/**
 * **The journey `test`**: Playwright's, with a client address per test and a
 * page that refuses to be photographed while it is erroring.
 *
 * ```ts
 * import { test, expect, resetJourneyStack } from "../tooling/journeys/src/playwright/fixtures.mts";
 * test.beforeAll(resetJourneyStack);
 * ```
 *
 * A project extends this with its own fixtures (`test.extend`) — an
 * organization, a signed-in session — the way door_nexa did; those are about
 * the app and do not belong here.
 */
import { expect, test as base } from "@playwright/test";
import type { Page } from "@playwright/test";
import { CONTROL_VAR } from "./config.mts";
import { resetStack } from "../stack/urls.mts";

export { expect } from "@playwright/test";

/**
 * **Back to the seeded state, once per spec file, first.**
 *
 * `test.beforeAll(resetJourneyStack)` — per file rather than per test, because a
 * per-test reset runs *after* that test's fixtures and deletes what they built.
 * The isolation pattern check (`pattern-check.mts`) requires every spec to call it before
 * anything else.
 */
export async function resetJourneyStack(): Promise<void> {
  const control = process.env[CONTROL_VAR];
  if (!control) {
    throw new Error(
      `JOURNEY-001: ${CONTROL_VAR} is not set, so there is no stack host to reset. ` +
        "It is set by defineJourneyPlaywrightConfig.",
    );
  }
  await resetStack(control);
}

const allowances = new WeakMap<Page, Array<{ pattern: RegExp; reason: string }>>();

/**
 * Permit one known page error, **with a reason** — a declaration, not a
 * suppression. *"A third-party widget logs on load"* is a reason; *"it was
 * failing"* is not. A long-lived dev server's errors are not a journey's to
 * declare: restart the server instead (door_nexa's Segment Explorer note).
 */
export function allowPageError(page: Page, pattern: RegExp, reason: string): void {
  const list = allowances.get(page) ?? [];
  list.push({ pattern, reason });
  allowances.set(page, list);
}

/**
 * A client address per test, from TEST-NET-3 (RFC 5737) — unroutable by
 * definition, so it is never mistaken for a customer in a rate-limit table.
 *
 * A rate limiter keyed on the client address otherwise sees every test as one
 * client, and the suite competes with itself (door_nexa: `429` on a sign-in,
 * which reads as a product refusal).
 */
export const clientIpFor = (workerIndex: number, parallelIndex: number, line: number): string => {
  const n = workerIndex * 64 + ((parallelIndex + line) % 64);
  return `203.0.113.${(n % 254) + 1}`;
};

export const test = base.extend<{ clientIp: string }>({
  clientIp: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads fixture dependencies from the pattern
    async ({}, use, testInfo) => {
      await use(clientIpFor(testInfo.workerIndex, testInfo.parallelIndex, testInfo.line));
    },
    { scope: "test" },
  ],

  /**
   * **`x-forwarded-for` reaches the app's own origin and nothing else.**
   *
   * Set on the context, because a limiter keys on it and `context.request`
   * inherits `extraHTTPHeaders` and cannot be intercepted by `context.route`.
   * Stripped from every other origin, because context-wide it also rides on a
   * third-party script's requests whose CORS preflight does not allow it — the
   * browser refuses them and the recording fails on a page that was working.
   * Both halves are load-bearing; each broke the other when it was alone.
   */
  context: async ({ browser, clientIp, baseURL }, use) => {
    const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": clientIp } });
    const ours = baseURL ? new URL(baseURL).origin : null;
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (ours !== null && new URL(request.url()).origin === ours) {
        await route.continue();
        return;
      }
      // Ours to add, so ours to take back off; anything else is passed through.
      const headers = { ...request.headers() };
      delete headers["x-forwarded-for"];
      await route.continue({ headers });
    });
    await use(context);
    await context.close();
  },

  /**
   * **Every journey watches for page errors**: an uncaught exception, or a
   * `console.error` (how a hydration mismatch is reported — it never throws).
   * A recording is evidence a human reviews, and evidence that photographs an
   * error indicator without comment teaches the reviewer to ignore it.
   * Warnings are not included: a gate that cries wolf gets bypassed.
   */
  page: async ({ page }, use) => {
    const seen: string[] = [];
    page.on("pageerror", (error) => seen.push(`[uncaught] ${error.message}`));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      // The URL is in `location()`, not the text; a pattern naming a host has to see it.
      const at = message.location().url;
      seen.push(`[console.error] ${message.text()}${at ? ` (${at})` : ""}`);
    });

    await use(page);

    const allowed = allowances.get(page) ?? [];
    const unexplained = seen.filter((line) => !allowed.some((a) => a.pattern.test(line)));
    expect(
      unexplained,
      [
        "The page errored while this journey was being recorded, so the screenshots",
        "show software that was not working. Fix it, or — if it is known and harmless —",
        "declare it: allowPageError(page, /pattern/, 'why this one is expected').",
      ].join("\n"),
    ).toEqual([]);
  },
});

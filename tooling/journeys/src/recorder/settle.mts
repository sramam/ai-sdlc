/**
 * **Waiting for the page to have arrived, before it is photographed.**
 *
 * A step photographed mid-arrival is the expensive failure of journey testing:
 * the learner diffs a half-rendered page against a whole one, boxes the
 * difference, and the mask — a union that only ever grows — hides that region
 * from every future comparison. So the recorder waits for a *condition* rather
 * than a timer, and the conditions are configuration because they are facts
 * about the app.
 *
 * ## The default is the one condition that is about meaning, not markup
 *
 * `[aria-busy="true"]` gone. A loading skeleton renders with it, and while it is
 * up the page's real elements **do not exist** — so any presence-guarded wait
 * finds nothing, concludes the element is absent, and skips the wait that exists
 * for exactly this moment. Measured: a skeleton-versus-table
 * box at 15.8% of the page (#614).
 *
 * ## Everything else is the project's, and `EXAMPLE_SETTLE` shows one app's
 *
 * | | waits for | because |
 * | --- | --- | --- |
 * | `[data-avatar]` | non-empty | Radix reveals the avatar fallback after mount (#573) |
 * | `#page-size` | a digit | a client-rendered select is empty until hydration |
 * | `.recharts-surface` | its tick text visible | the chart measures, then paints axes (#654) |
 *
 * **Each applies only where its selector is present**, so a page without a chart
 * pays nothing for the chart's wait. That makes the waits presence-guarded —
 * which is safe only *after* the busy wait, for the reason above.
 *
 * **A wait rather than a mask, always.** A region still arriving is *settling*,
 * which the learner refuses to mask (`classifyMotion`), so relearning cannot
 * absorb it however many passes it is given. That refusal is the signal.
 */
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { SettleConfig } from "./settle-config.mts";

export { DEFAULT_SETTLE, EXAMPLE_SETTLE, resolveSettle } from "./settle-config.mts";
export type { SettleConfig, SettleSelector, SettleUntil } from "./settle-config.mts";

/** Wait for the busy marker to clear, then for every configured selector present. */
export async function waitForSettled(page: Page, settle: SettleConfig): Promise<void> {
  const timeout = settle.timeoutMs;
  await expect(page.locator(settle.busySelector)).toHaveCount(0, { timeout });

  for (const { selector, until } of settle.selectors) {
    const found = page.locator(selector);
    if ((await found.count()) === 0) continue;
    const first = found.first();
    if (until === "non-empty") await expect(first).not.toBeEmpty({ timeout });
    else if (until === "visible") await expect(first).toBeVisible({ timeout });
    else if ("text" in until) await expect(first).toHaveText(new RegExp(until.text), { timeout });
    // The surface exists from the first frame; waiting on it would be vacuous.
    else await expect(page.locator(until.visible).first()).toBeVisible({ timeout });
  }
}

/**
 * Grow the viewport to the scroll container's content; returns the restore.
 *
 * Asking the container how tall its content is, and making the window that
 * tall, needs no knowledge of the layout — releasing the container's overflow
 * was tried first and fails, because every ancestor is
 * viewport-height too. Width is untouched, so no breakpoint moves.
 */
export async function growToContent(
  page: Page,
  settle: SettleConfig,
): Promise<() => Promise<void>> {
  const nothing = async () => {};
  if (!settle.scrollContainer) return nothing;
  const extra = await page.evaluate((selector) => {
    const scroller = document.querySelector(selector);
    if (!scroller) return null;
    const more = scroller.scrollHeight - scroller.clientHeight;
    return more > 0 ? more : null;
  }, settle.scrollContainer);
  const viewport = page.viewportSize();
  if (!extra || !viewport) return nothing;
  await page.setViewportSize({
    width: viewport.width,
    height: Math.min(viewport.height + extra, settle.maxHeight),
  });
  return async () => page.setViewportSize(viewport);
}

/**
 * Hide framework chrome and the caret, for this screenshot; say what was found.
 *
 * **The caret by stylesheet, never Playwright's `caret: "hide"`.** That option
 * writes `style="caret-color: transparent"` onto every input — a DOM mutation
 * React then hydrates against, which produced 102 console errors on one
 * journey. A `<style>` appended outside the app root mutates nothing React owns.
 *
 * **Re-added per screenshot**: a full navigation replaces the document and
 * takes an injected `<style>` with it.
 */
export async function hideForScreenshot(
  page: Page,
  settle: SettleConfig,
): Promise<{ found: number; painting: string[] }> {
  const hidden = settle.hide.length
    ? `${settle.hide.join(", ")} { display: none !important; }\n`
    : "";
  await page.addStyleTag({ content: `${hidden}* { caret-color: transparent !important; }` });
  if (settle.hide.length === 0) return { found: 0, painting: [] };
  return page.evaluate((selectors) => {
    const marks = Array.from(document.querySelectorAll(selectors.join(", ")));
    return {
      found: marks.length,
      painting: marks
        .filter((el) => {
          const box = el.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        })
        .map((el) => el.tagName.toLowerCase()),
    };
  }, settle.hide);
}

/**
 * **Was the page still changing while it was photographed?** (#1513)
 *
 * A `MutationObserver` installed before the shot and read straight after: the
 * window it observes is the time the screenshot already takes, so it costs no
 * wall time. `childList` and `characterData` — content arriving — and not
 * `attributes`, which would warn on a focus ring.
 */
export async function watchMutations(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __journeySettling?: string[];
      __journeyObserver?: MutationObserver;
    };
    w.__journeyObserver?.disconnect();
    const seen: string[] = [];
    w.__journeySettling = seen;
    const observer = new MutationObserver((records) => {
      if (seen.length > 40) return;
      for (const record of records) {
        const node = record.target;
        const element = node instanceof Element ? node : node.parentElement;
        if (!element) continue;
        seen.push(element.tagName.toLowerCase() + (element.id ? `#${element.id}` : ""));
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    w.__journeyObserver = observer;
  });
}

/** What changed since `watchMutations`, deduplicated and capped. */
export async function readMutations(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __journeySettling?: string[];
      __journeyObserver?: MutationObserver;
    };
    w.__journeyObserver?.disconnect();
    return [...new Set(w.__journeySettling ?? [])].slice(0, 6);
  });
}

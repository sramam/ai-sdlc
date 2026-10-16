/**
 * The settle configuration, its default and door_nexa's example — apart from
 * `settle.mts` so that reading a config never loads Playwright. See `settle.mts`
 * for what each wait is for.
 */
export type SettleUntil =
  /** The element has some text or child content. */
  | "non-empty"
  | "visible"
  /** The element's text matches this regex source. */
  | { text: string }
  /** Another element, found anywhere on the page, is visible. */
  | { visible: string };

export type SettleSelector = { selector: string; until: SettleUntil; why?: string };

export type SettleConfig = {
  /** Waits that apply only where their selector is present. */
  selectors: SettleSelector[];
  /**
   * The element that scrolls instead of the document, if the app shell has one.
   *
   * `fullPage` screenshots the **document**, and an `h-screen` shell with an
   * inner scroller keeps the document viewport-sized — door_nexa's `fullPage`
   * was inert for a year, every image 1280×720 (#679). Naming the scroller lets
   * the recorder grow the viewport to its content for the shot.
   */
  scrollContainer?: string;
  /**
   * Selectors hidden with `display: none` at the instant of each screenshot.
   *
   * For chrome that belongs to a framework rather than the app — Next's dev
   * overlay is the example (`nextjs-portal`). Hidden rather than masked: it
   * appears intermittently, which is the case a learner cannot see. A hide rule
   * that stops matching is reported (see the recorder), because three of
   * Next's badges reached door_nexa's committed evidence silently.
   */
  hide: string[];
  /** The busy marker. `[aria-busy="true"]` unless the app spells loading differently. */
  busySelector: string;
  timeoutMs: number;
  /** A runaway list must not ask for a 30,000px image. */
  maxHeight: number;
};

export const DEFAULT_SETTLE: SettleConfig = {
  selectors: [],
  hide: [],
  busySelector: '[aria-busy="true"]',
  timeoutMs: 20_000,
  maxHeight: 4_000,
};

/**
 * door_nexa's settings, as an example to copy from — **not** a default. A
 * Next.js + Radix + Recharts app would write exactly this.
 */
export const EXAMPLE_SETTLE: Partial<SettleConfig> = {
  selectors: [
    {
      selector: "[data-avatar]",
      until: "non-empty",
      why: "Radix reveals the fallback after mount",
    },
    {
      selector: "#page-size",
      until: { text: "\\d" },
      why: "the select's value renders on hydration",
    },
    {
      selector: ".recharts-surface",
      until: { visible: ".recharts-cartesian-axis-tick-value" },
      why: "the chart measures its container, then paints axes",
    },
  ],
  scrollContainer: "[data-app-scroll]",
  hide: ["nextjs-portal"],
};

export function resolveSettle(input: Partial<SettleConfig> = {}): SettleConfig {
  return { ...DEFAULT_SETTLE, ...input };
}

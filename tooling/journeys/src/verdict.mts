/**
 * Whether a journey is QA's, and the sentence that says so.
 *
 * **Two writers publish this verdict and they must not disagree.**
 * the recorder (step 3) writes each journey's own page while recording it;
 * the index CLI (step 4) writes the four index pages afterwards. Both had
 * their own copy of the sign-off parse and the status sentence, so a reader
 * could open a journey page saying *not ready* from an index that had already
 * handed it to QA — which is precisely what happened to J35 on 2026-09-03.
 *
 * Shared rather than copied. `journey.ts` already imports `scripts/journeys.mts`,
 * so the direction is established; this module deliberately imports nothing, so
 * neither Playwright's graph nor `tsx`'s pulls the other's in.
 *
 * **A sign-off changes no recording**, which is the whole reason this is not
 * left to the recorder. Publishing one must not require re-running a browser:
 * the run could fail on unrelated visual drift, and a QA release would then be
 * blocked by something that has nothing to do with the decision.
 */

export type IdOptions = {
  /**
   * The literal prefixes a journey id may carry, before its number.
   *
   * Unset means **any one letter**, so `J31` and the
   * platform track `P1` both release. A project whose ids read `JRN-12` passes
   * `["JRN-"]`. Literal rather than a regex source, so a prefix containing `.`
   * or `+` means what it says; longest first, so `JX` is not read as `J`.
   */
  prefixes?: readonly string[];
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The regex fragment matching an id: a prefix, then digits. */
export function idPattern({ prefixes }: IdOptions = {}): string {
  if (!prefixes || prefixes.length === 0) return "[A-Za-z]\\d+";
  const alternatives = [...prefixes].sort((a, b) => b.length - a.length).map(escape);
  return `(?:${alternatives.join("|")})\\d+`;
}

/**
 * The journeys a **person** has signed off, from the one hand-written file in
 * `docs/journeys/`.
 *
 * Parsed from `- J<n>` at the start of a line (the prefix is configurable — see
 * `IdOptions`), so the file stays a document
 * somebody reads rather than a config somebody maintains. `\[?` so a linked
 * entry and a bare one both release — the id is the identifier and the link is
 * for the reader, and a journey silently unreleased for a missing bracket is
 * worse than a rule that is easy to satisfy.
 *
 * **Empty input releases nothing**, which is the safe direction: a missing file
 * must not read as "QA may pick everything up".
 */
export function signedOffIds(readyForQa: string, options: IdOptions = {}): Set<string> {
  const entry = new RegExp(`^-\\s+\\[?(?<id>${idPattern(options)})\\b`);
  const ids = new Set<string>();
  for (const line of readyForQa.split("\n")) {
    const match = entry.exec(line);
    if (match?.groups?.id) ids.add(match.groups.id);
  }
  return ids;
}

/** Does this file release that journey? The single-id form of `signedOffIds`. */
export function isSignedOff(readyForQa: string, id: string, options: IdOptions = {}): boolean {
  return signedOffIds(readyForQa, options).has(id);
}

/**
 * The status line at the top of a journey's own page.
 *
 * Three states, and the first outranks the sign-off deliberately: a released
 * journey that has gone red is **not** QA's, and a sign-off must not be usable
 * to push a failing journey past the gate. `ready-for-qa.md` says the same in
 * prose; this is where it is true.
 */
export function journeyStatusLine({
  failingPaths,
  totalPaths,
  signedOff,
  register = "../ready-for-qa.md",
}: {
  /** Path names whose narrative carries a failure marker. */
  failingPaths: readonly string[];
  totalPaths: number;
  signedOff: boolean;
  /**
   * How to reach `ready-for-qa.md` **from the page being written** (#928).
   *
   * It was a literal `../ready-for-qa.md` in the sentence below, which is
   * right for a journey page and wrong one level down — and both pages come
   * from this one function, deliberately, because *"two writers of one fact
   * will otherwise word it differently"*.
   *
   * | written by | lives at | needs |
   * | --- | --- | --- |
   * | `journey-index.mts` | `<journey>/README.md` | `../` |
   * | `writeJourneyIndex` | `<journey>/<persona>/README.md` | `../../` |
   *
   * So the persona level (#883) put twelve walk pages one directory further
   * down and left the sentence where it was. Changing the literal to `../../`
   * would have repaired those twelve and broken the fourteen journey pointers
   * that are currently right — which is why the depth is a parameter rather
   * than a better constant.
   *
   * The default is the journey level, so the three call sites that were
   * already correct say nothing and cannot drift; only the one that is two
   * deep declares it.
   */
  register?: string;
}): string {
  if (failingPaths.length > 0) {
    const named = failingPaths.map((p) => `\`${p}\``).join(", ");
    return (
      `**In Dev Testing — not ready for QA.** ${failingPaths.length} of ${totalPaths} ` +
      `paths do not pass (${named}), so what follows is what this journey is *meant* ` +
      "to do. See the implementation notes for why."
    );
  }

  return signedOff
    ? `**Dev Tested — ready for QA.** Every path below is recorded and green, and it is released in [ready-for-qa.md](${register}).`
    : "**In Dev Testing — not ready for QA.** Every path below is green; nobody " +
        `has released it in [ready-for-qa.md](${register}) yet.`;
}

/**
 * A journey page's status line is the first line starting `**In Dev Testing`
 * or `**Dev Tested`, and replacing it is how a sign-off is published without
 * re-recording.
 *
 * Returns the document unchanged when no such line is found, rather than
 * inserting one: a page that does not look like a journey page is one this
 * function does not understand, and writing into it would corrupt whatever it
 * actually is. The caller reports that as a skip.
 */
export function withStatusLine(page: string, line: string): string {
  const lines = page.split("\n");
  const at = lines.findIndex(
    (l) => l.startsWith("**In Dev Testing") || l.startsWith("**Dev Tested"),
  );
  if (at === -1) return page;
  lines[at] = line;
  return lines.join("\n");
}

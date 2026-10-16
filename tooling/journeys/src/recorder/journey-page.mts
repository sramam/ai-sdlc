/**
 * **A walk's own page, above its paths** — `<journey>/<persona>/README.md`.
 *
 * Three people open it and their questions do not overlap:
 *
 * | | asks | reads |
 * | --- | --- | --- |
 * | whoever owns the product | what is this for, what does it promise | *Why this matters*, *What somebody can rely on* |
 * | QA | what do I test, and what is not covered | *Paths recorded*, *Test these by hand* |
 * | whoever changes it | how does it work | *Implementation notes* |
 *
 * **The plain-language half comes first and stays plain.** Every field is
 * required, because the technical half is what a spec author has in their head
 * and the business half is what drifts to blank.
 *
 * **`byHand` is the section with no test behind it, and it is the point.** A
 * recording proves what it walks; what it cannot reach is invisible unless
 * written down, each with why — so the list is a decision rather than a backlog.
 *
 * Written from the spec (`test.afterAll`), after every path has written its
 * README, so the status line is derived from the recordings exactly as the
 * index derives it. The page *above* this one — `<journey>/README.md`, a
 * pointer to each persona's walk — is written by `journeys index` from disk,
 * because two personas recorded on two branches would otherwise author one
 * shared page and conflict in prose.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertPersona, assertTitle, journeyFolder, personaLabel } from "../registry.mts";
import { isSignedOff, journeyStatusLine } from "../verdict.mts";
import { GENERATED, pathIsGreen, writePersonaMarker } from "./evidence.mts";
import { journeyContext } from "./journey.mts";
import type { JourneyContext } from "./journey.mts";

/** One step of the flow in words, with what follows from it beneath. */
export type FlowNote = { text: string; then?: FlowNote[] };

export type JourneyPage = {
  id: string;
  title: string;
  persona: string;
  /** Why this journey exists, in a sentence a non-engineer reads. */
  summary: string;
  /** The flow as mermaid. **Every recorded path must appear in it**, by name. */
  flow: string;
  /** The same flow in words — searchable, quotable and readable by a screen reader, which a diagram is not. */
  flowInWords: FlowNote[];
  /** What a person can count on, in their words rather than the schema's. */
  promises: string[];
  paths: Array<{ path: string; title: string; proves: string }>;
  /**
   * A corner case no recording reaches, and **why**. `restsOn` names what the
   * reason depends on — an issue, a decision — so a reason that has gone stale
   * can be found by what it cites rather than by re-reading prose.
   */
  byHand: Array<{ check: string; why: string; restsOn?: string[] }>;
  implementation: string[];
};

const renderFlow = (notes: readonly FlowNote[], depth = 0): string[] =>
  notes.flatMap((note) => [
    `${"  ".repeat(depth)}- ${note.text}`,
    ...renderFlow(note.then ?? [], depth + 1),
  ]);

/** The page's text, given what is on disk. Pure, apart from the reads it is handed. */
export function renderJourneyPage(
  page: JourneyPage,
  { failingPaths, signedOff }: { failingPaths: string[]; signedOff: boolean },
): string {
  const lines = [
    `# ${page.id} ${page.title}`,
    "",
    GENERATED,
    "> Every word below is authored beside the test that walks it, so this page",
    "> cannot describe behaviour nothing exercises.",
    "",
    // Two levels above the register: `<journey>/<persona>/README.md`.
    journeyStatusLine({
      register: "../../ready-for-qa.md",
      failingPaths,
      totalPaths: page.paths.length,
      signedOff,
    }),
    "",
    "## Why this matters",
    "",
    page.summary,
    "",
    "## The flow",
    "",
    "What the journey is for, and where it branches. Every recorded path below",
    "appears here.",
    "",
    "```mermaid",
    page.flow.trim(),
    "```",
    "",
    ...renderFlow(page.flowInWords),
    "",
    "## What somebody can rely on",
    "",
    ...page.promises.map((p) => `- ${p}`),
    "",
    "## Paths recorded",
    "",
    "Each folder holds a screenshot per interaction and a narrative naming what the",
    "person did and what they then saw. An error path is a path: a journey recorded",
    "only along the route that works has not shown that the guards refuse anything.",
    "",
    "| | proves | |",
    "| --- | --- | --- |",
    ...page.paths.map(
      (p) =>
        `| [${p.title}](${p.path}/README.md) | ${p.proves} | [what was compared](${p.path}/diff.md) |`,
    ),
    "",
    "## Test these by hand",
    "",
    "What the recordings **cannot** reach, and why. Automated coverage is not the",
    "same as coverage, and the difference is only visible if it is written down.",
    "",
    "| check | why it is not automated |",
    "| --- | --- |",
    ...page.byHand.map(
      (b) =>
        `| ${b.check} | ${b.why}${b.restsOn?.length ? ` **Rests on** ${b.restsOn.join(", ")}.` : ""} |`,
    ),
    "",
    "## Implementation notes",
    "",
    ...page.implementation.map((i) => `- ${i}`),
  ];
  return lines.join("\n") + "\n";
}

/** Write the walk's page, refusing a flow that has stopped mentioning a path. */
export async function writeJourneyPage(
  page: JourneyPage,
  context?: JourneyContext,
): Promise<string> {
  const { root, config } = context ?? (await journeyContext());
  const journey = assertTitle(config.registry, page.id, page.title);
  assertPersona(config.registry, journey, page.persona);

  const unmentioned = page.paths.filter((p) => !page.flow.includes(p.path));
  if (unmentioned.length > 0) {
    throw new Error(
      `JOURNEY-026: ${page.id}'s flow diagram does not mention ${unmentioned.map((p) => p.path).join(", ")}. ` +
        "Every recorded path belongs in it — as a branch, or at least by name.",
    );
  }

  const evidence = join(root, config.evidenceRoot);
  const dir = join(evidence, journeyFolder(page.id, page.title), page.persona);
  mkdirSync(dir, { recursive: true });
  writePersonaMarker(dir, page.persona, personaLabel(config.registry, page.persona));

  const register = join(evidence, "ready-for-qa.md");
  const signedOff = existsSync(register)
    ? isSignedOff(readFileSync(register, "utf8"), page.id, { prefixes: config.idPrefixes })
    : false;
  const failingPaths = page.paths
    .filter((p) => {
      const readme = join(dir, p.path, "README.md");
      return !existsSync(readme) || !pathIsGreen(readFileSync(readme, "utf8"));
    })
    .map((p) => p.path);

  const file = join(dir, "README.md");
  writeFileSync(file, renderJourneyPage(page, { failingPaths, signedOff }));
  return file;
}

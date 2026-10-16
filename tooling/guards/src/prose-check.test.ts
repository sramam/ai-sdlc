/**
 * The prose pattern check: green on this repository's own markdown, and
 * tripped one rule at a time.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { result, scriptedExec } from "../../core/src/exec.mts";
import { checkText, isExcluded, proseLines, runProseCheck } from "./prose-check.mts";

const REPO = join(import.meta.dirname, "..", "..", "..");
const rules = (text: string) => checkText(text, "x.md").map((f) => f.rule);

describe("this repository", () => {
  it("every tracked markdown file passes", async () => {
    const o = await runProseCheck(REPO, []);
    expect(
      o.state,
      o.findings.map((f) => `${f.file}:${f.line} ${f.rule} ${f.excerpt}`).join("\n"),
    ).toBe("ok");
    expect(o.files).toBeGreaterThan(50);
  });
});

describe("what is not prose", () => {
  it("blanks frontmatter, fences, comments, quotes, inline code and link targets", () => {
    const text = [
      "---",
      "description: a — dash in yaml",
      "---",
      "Prose `with — code` and [a link](http://x.y/a—b) <!-- and — a comment -->",
      "```",
      "a — fenced dash",
      "```",
      "> a — quoted dash",
      "<!--",
      "a — multi-line comment",
      "-->",
      "plain",
    ].join("\n");
    expect(proseLines(text).filter((l) => l.includes("—"))).toEqual([]);
    expect(rules(text)).toEqual([]);
  });
});

describe("each rule, tripped", () => {
  it("dash: an em dash, or an en dash that is not a numeric range", () => {
    expect(rules("The policy — announced without warning — applies.")).toEqual(["dash"]);
    expect(rules("Workers – the runtime – apply.")).toEqual(["dash"]);
    expect(rules("Ports 55000–55499, and § 2–3, are ranges.")).toEqual([]);
  });

  it("bold: inside a sentence, or a second label on one line", () => {
    expect(rules("Authorization goes **only** through the engine.")).toEqual(["bold"]);
    expect(rules("- **Clarity**: one reading.\n- **Fidelity**: true to its source.")).toEqual([]);
    expect(rules("| **Key** | a cell |\n| **Other** | b |")).toEqual([]);
    expect(rules("**A label** at the start of a paragraph is fine.")).toEqual([]);
    expect(rules("**Before:** x **After:** y")).toEqual(["bold"]);
  });

  it("bold: a continuation line of a wrapped paragraph is not a label position", () => {
    expect(
      rules("A sentence that wraps and whose next line begins\n**with bold** mid-sentence."),
    ).toEqual(["bold"]);
    expect(rules("## Heading\n\n**Label.** The paragraph after a blank line.")).toEqual([]);
  });

  it("word: the stock list, case-insensitive", () => {
    expect(rules("Let us delve into the robust tapestry.")).toEqual(["word"]);
    expect(rules("This is crucial and seamless.")).toEqual(["word"]);
    expect(rules("Additionally, we leverage it.")).toEqual(["word"]);
    expect(rules("An underscore separates words.")).toEqual([]);
  });

  it("heading: Title Case below the title, or an emoji", () => {
    expect(rules("## Strategic Negotiations And Global Partnerships")).toEqual(["heading"]);
    expect(rules("# Test-Driven Development")).toEqual([]);
    expect(rules("## Phase 0: create the project")).toEqual([]);
    expect(rules("## Cloudflare Workers constraints")).toEqual([]);
    expect(rules("## OTEL and ASVS")).toEqual([]);
    // Runs of product names are not Title Case; CamelCase names never count.
    expect(rules("## Mount it (TanStack Start on Workers)")).toEqual([]);
    expect(rules("## A binding, in TanStack Start")).toEqual([]);
    expect(rules("## 🚀 Launch phase")).toEqual(["heading"]);
  });

  it("bold: a task-list item's label is a label", () => {
    expect(rules("- [ ] **Static first, dynamic last.** Role and rules come first.")).toEqual([]);
    expect(rules("- [x] **Done**: the item.")).toEqual([]);
  });

  it("quote: curly quotation marks", () => {
    expect(rules("He said “on track” but it’s not.")).toEqual(["quote"]);
    expect(rules('He said "on track" but it\'s not.')).toEqual([]);
  });

  it("residue: chatbot wrappers and staged openers", () => {
    expect(rules("Great question! Here is the plan.")).toEqual(["residue"]);
    expect(rules("Let's dive in.")).toEqual(["residue"]);
    expect(rules("To be clear, the lock is per checkout.")).toEqual(["residue"]);
    expect(rules("Be clear about the lock.")).toEqual([]);
  });
});

describe("exceptions", () => {
  it("cover the next line, with a reason of three words or more", () => {
    expect(
      rules(
        "<!-- prose-check: allow dash (a quoted upstream title) -->\nThe title — as published.",
      ),
    ).toEqual([]);
    expect(rules("<!-- prose-check: allow dash (quoted) -->\nThe title — as published.")).toEqual([
      "exception",
    ]);
    // After content has begun, a comment covers only the line below it.
    expect(
      rules(
        "intro\n<!-- prose-check: allow dash (a quoted upstream title) -->\nfine\nThe next — line.",
      ),
    ).toEqual(["dash"]);
    // A blank line between the comment and the line (prettier adds one) does not use it up.
    expect(
      rules(
        "intro\n<!-- prose-check: allow dash (a quoted upstream title) -->\n\nThe title — as published.",
      ),
    ).toEqual([]);
  });

  it("at the top of a file, cover the whole file for the named rules only", () => {
    const text =
      "<!-- prose-check: allow dash, bold (a record of upstream text) -->\n\n# T\n\na — b **only** c\n\nLet's dive in.";
    expect(rules(text)).toEqual(["residue"]);
  });
});

describe("discovery", () => {
  it("skips excluded paths", () => {
    expect(isExcluded(".agents/3rdparty/x/SKILL.md")).toBe(true);
    expect(isExcluded("docs/requirements/sources/brd.md")).toBe(true);
    expect(isExcluded("tooling/plan/src/__fixtures__/plan/good/docs/x.md")).toBe(true);
    expect(isExcluded("docs/kit/sdlc.md")).toBe(false);
  });

  it("asks git for the tracked files, and reports could not ask when git does not answer", async () => {
    const silent = scriptedExec([[/^git ls-files/, result(128, "", "not a git repository")]]);
    const o = await runProseCheck("/nowhere", [], silent);
    expect(o.state).toBe("could-not-ask");
  });
});

/**
 * Every abort before pass 3 leaves the committed evidence exactly as it was —
 * screenshots, masks, narratives and the index — against a real directory
 * tree, with the passes staged by fakes that write into it the way the
 * recorder does.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupEvidence } from "./evidence-backup.mts";
import { runPasses } from "./passes.mts";
import type { PassDeps } from "./passes.mts";

let dir = "";
let evidence = "";
let backupDir = "";

/** Every file under the evidence root, with its contents. */
function tree(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const e of readdirSync(at)) {
      const p = join(at, e);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(evidence, p)] = readFileSync(p, "utf8");
    }
  };
  if (existsSync(evidence)) walk(evidence);
  return out;
}

function put(rel: string, content: string) {
  mkdirSync(join(evidence, rel, ".."), { recursive: true });
  writeFileSync(join(evidence, rel), content);
}

/** What a recording pass does to the tree: a new reference, a grown mask, a rewritten narrative and index, a new walk. */
function record(pass: number) {
  put("J1-walk/common/happy/snapshots/01-home.png", `pixels from pass ${pass}`);
  put("J1-walk/common/happy/snapshots/01-home.png.mask.json", `{"boxes":${pass}}`);
  put("J1-walk/common/happy/README.md", `narrative of pass ${pass}`);
  put("J1-walk/common/new-path/run.json", "{}");
  put("README.md", `index after pass ${pass}`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "journeys-passes-"));
  evidence = join(dir, "docs/journeys");
  backupDir = join(dir, "test-results/evidence-before-learn");
  put("J1-walk/common/persona.json", '{"key":"common"}');
  put("J1-walk/common/happy/snapshots/01-home.png", "committed pixels");
  put("J1-walk/common/happy/snapshots/01-home.png.mask.json", '{"boxes":0}');
  put("J1-walk/common/happy/README.md", "committed narrative");
  put("J2-other/common/happy/README.md", "another journey");
  put("README.md", "committed index");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(over: Partial<PassDeps> & { resets?: boolean[] }): PassDeps & { played: string[] } {
  const resets = [...(over.resets ?? [true, true, true])];
  const played: string[] = [];
  let pass = 0;
  return {
    played,
    backup: () => backupEvidence(evidence, backupDir, "J1"),
    reset: async () => resets.shift() ?? true,
    play: (label) => {
      played.push(label);
      record(++pass);
      return 0;
    },
    probe: async () => "up",
    ...over,
  };
}

describe("runPasses", () => {
  it("restores everything when the host will not reset before pass 2", async () => {
    const before = tree();
    const d = deps({ resets: [true, false] });
    const outcome = await runPasses(d);
    expect(outcome.kind).toBe("aborted");
    if (outcome.kind === "aborted") {
      expect(outcome.pass).toBe(2);
      expect(outcome.why).toEqual({ kind: "reset" });
      expect(outcome.undone.reverted).toEqual(["J1-walk", "README.md"]);
    }
    expect(d.played).toHaveLength(1);
    expect(tree()).toEqual(before);
    expect(existsSync(backupDir)).toBe(false);
  });

  it("restores everything when the host will not reset before pass 3", async () => {
    const before = tree();
    const outcome = await runPasses(deps({ resets: [true, true, false] }));
    expect(outcome).toMatchObject({ kind: "aborted", pass: 3, why: { kind: "reset" } });
    expect(tree()).toEqual(before);
  });

  it("restores everything, and removes a journey the run created, when the stack dies", async () => {
    const before = tree();
    const outcome = await runPasses(
      deps({
        backup: () => backupEvidence(evidence, backupDir),
        play: () => {
          record(1);
          put("J3-brand-new/common/happy/README.md", "first recording");
          return 0;
        },
        probe: async () => "down",
      }),
    );
    expect(outcome).toMatchObject({
      kind: "aborted",
      pass: 1,
      why: { kind: "stack", verdict: "down" },
    });
    if (outcome.kind === "aborted") expect(outcome.undone.removed).toEqual(["J3-brand-new"]);
    expect(tree()).toEqual(before);
  });

  it("restores on an interrupt during a pass", async () => {
    const before = tree();
    let interrupt: (() => unknown) | undefined;
    const d = deps({
      onInterrupt: (undo) => {
        interrupt = undo;
        return () => (interrupt = undefined);
      },
      play: () => {
        record(1);
        interrupt?.(); // what SIGINT does in the learner, which then exits
        throw new Error("process.exit(130)");
      },
    });
    await expect(runPasses(d)).rejects.toThrow(/exit/);
    expect(interrupt).toBeDefined();
    expect(tree()).toEqual(before);
  });

  it("keeps what pass 3 verified, and drops the copy once finished", async () => {
    const outcome = await runPasses(deps({}));
    expect(outcome.kind).toBe("verified");
    if (outcome.kind === "verified") outcome.finish();
    expect(tree()["J1-walk/common/happy/snapshots/01-home.png"]).toBe("pixels from pass 3");
    expect(existsSync(backupDir)).toBe(false);
  });

  it("leaves a journey outside the run's scope alone", async () => {
    await runPasses(
      deps({
        resets: [true, false],
        play: () => {
          record(1);
          put("J2-other/common/happy/README.md", "touched by somebody else meanwhile");
          return 0;
        },
      }),
    );
    expect(tree()["J2-other/common/happy/README.md"]).toBe("touched by somebody else meanwhile");
  });
});

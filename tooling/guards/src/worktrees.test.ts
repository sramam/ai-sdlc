import { describe, expect, it } from "vitest";
import type { RegistryEvent, WorktreeRecord } from "./worktree-registry.mts";
import { closeVerdict, report } from "./worktrees.mts";

const record = (over: Partial<WorktreeRecord> = {}): WorktreeRecord => ({
  worktree: "alpha",
  createdBy: "1c1c3a24aaaa",
  branch: "feat/at-creation",
  firstSeen: "2026-10-01T00:00:00.000Z",
  enteredBy: [],
  ...over,
});

describe("the report", () => {
  it("labels the session column as created-by, never occupancy", () => {
    const out = report([record()], [{ name: "alpha" }]);
    expect(out).toContain("created by");
    expect(out).toContain("never who is in it now");
    expect(out).toContain("1c1c3a24");
  });

  it("prints the live branch, falling back to the recorded one", () => {
    expect(report([record()], [{ name: "alpha", branch: "fix/today" }])).toContain("fix/today");
    expect(report([record()], [{ name: "alpha", branch: "fix/today" }])).not.toContain(
      "feat/at-creation",
    );
    expect(report([record()], [{ name: "alpha" }])).toContain("feat/at-creation");
  });

  it("shows who else entered", () => {
    expect(report([record({ enteredBy: ["a040c8b7ffff"] })], [{ name: "alpha" }])).toContain(
      "entered by a040c8b7",
    );
  });

  it("reports drift in both directions", () => {
    const out = report([record({ worktree: "gone" })], [{ name: "surprise" }]);
    expect(out).toContain("no record");
    expect(out).toContain("pnpm worktrees --close gone");
    expect(out).toContain("never saw");
  });

  /** Prints on success: an empty report must not look like one that never ran. */
  it("says so when nothing drifts", () => {
    expect(report([record()], [{ name: "alpha" }])).toContain("No drift");
    expect(report([], [])).toContain("none under .claude/worktrees/");
  });
});

describe("closing", () => {
  const at = "2026-10-15T00:00:00.000Z";
  const events: RegistryEvent[] = [
    { at, kind: "created", worktree: "done", sessionId: "s1" },
    { at, kind: "created", worktree: "other", sessionId: "s2" },
  ];

  it("prunes a tree that is gone from disk", () => {
    const result = closeVerdict(events, "done", [{ name: "other" }]);
    expect(result.ok).toBe(true);
    expect(result.events).toEqual([events[1]]);
  });

  it("refuses a tree still on disk, and says how to remove it", () => {
    const result = closeVerdict(events, "done", [{ name: "done" }]);
    expect(result.ok).toBe(false);
    expect(result.events).toBeUndefined();
    expect(result.message).toContain("git worktree remove .claude/worktrees/done");
  });

  it("refuses when it could not ask git", () => {
    expect(closeVerdict(events, "done", null)).toMatchObject({ ok: false });
  });

  it("is a no-op for a name it never recorded", () => {
    const result = closeVerdict(events, "never", []);
    expect(result.ok).toBe(true);
    expect(result.events).toBeUndefined();
  });
});

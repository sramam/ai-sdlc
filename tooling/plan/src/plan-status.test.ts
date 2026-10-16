import { afterEach, describe, expect, it } from "vitest";
import { cleanup, commit, initRepo, sh, tempDir, write } from "./__fixtures__/plan/temp-repo.ts";
import {
  blockedBy,
  deriveStatuses,
  factsFromCommits,
  gatherFacts,
  rankQuestions,
  renderHtml,
  renderText,
  toJson,
} from "./plan-status.mts";
import type { Claim, GitFacts } from "./plan-status.mts";
import { loadModel, parseItem, parseQuestion } from "./plan-lib.mts";
import type { Item, Question } from "./plan-lib.mts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop() ?? "");
});

const DAY = 86400;
const NOW = 1_800_000_000;

function item(id: string, extra = ""): Item {
  return parseItem(
    `---\nid: ${id}\ntitle: ${id} title\nrequirements: []\nmilestone: M1\n${extra}---\n`,
    `docs/plan/items/${id}.md`,
    `${id}.md`,
  );
}
function question(id: string, blocks: string, answered = ""): Question {
  return parseQuestion(
    `---\nid: ${id}\nblocks: [${blocks}]\nanswered: ${answered}\n---\n# ${id} title\n`,
    `q/${id}.md`,
    `${id}.md`,
  );
}
function facts(over: Partial<GitFacts> = {}): GitFacts {
  return {
    ref: "origin/dev",
    notes: [],
    closes: new Map(),
    progress: new Map(),
    claims: [],
    now: NOW,
    ...over,
  };
}
function claim(id: string, tip: number, claimedAt: number | null): Claim {
  return {
    id,
    branch: id.toLowerCase(),
    tip,
    claimedAt,
    claimedBy: null,
    source: claimedAt === null ? "unknown" : "claim commit",
  };
}
const statusOf = (items: Item[], qs: Question[], f: GitFacts) =>
  Object.fromEntries(deriveStatuses(items, qs, f, 7).map((s) => [s.item.id, s.status]));

describe("deriveStatuses", () => {
  it("covers every status", () => {
    const items = [
      item("X-001"),
      item("F01-001"),
      item("F01-002", "depends: [F01-001]\n"),
      item("F01-003"),
      item("F01-004", "dropped: 2026-10-01 not needed\n"),
      item("F01-005"),
      item("F01-006"),
      item("F01-007"),
    ];
    const f = facts({
      closes: new Map([["X-001", { commit: "abc", time: NOW }]]),
      claims: [
        claim("F01-001", NOW - DAY, NOW - DAY),
        claim("F01-005", NOW - 30 * DAY, NOW - 30 * DAY),
      ],
      progress: new Map([
        ["F01-006", NOW - 2 * DAY],
        ["F01-007", NOW - 20 * DAY],
      ]),
    });
    expect(statusOf(items, [question("Q-001", "F01-003")], f)).toEqual({
      "X-001": "done",
      "F01-001": "in progress",
      "F01-002": "blocked",
      "F01-003": "blocked",
      "F01-004": "dropped",
      "F01-005": "stale claim",
      "F01-006": "in progress",
      "F01-007": "stale claim",
    });
  });

  it("stale needs both an old claim and no recent commit", () => {
    const at = (c: Claim) => statusOf([item(c.id)], [], facts({ claims: [c] }))[c.id];
    // Old claim, recent work: in progress.
    expect(at(claim("F01-001", NOW - DAY, NOW - 30 * DAY))).toBe("in progress");
    // A tip dated long ago (a fresh claim off an old dev tip) but a recent claim: in progress.
    expect(at(claim("F01-001", NOW - 60 * DAY, NOW - DAY))).toBe("in progress");
    // A claim whose time cannot be told is never stale on that account.
    expect(at(claim("F01-001", NOW - 60 * DAY, null))).toBe("in progress");
    // Old claim, nothing since: stale.
    expect(at(claim("F01-001", NOW - 20 * DAY, NOW - 30 * DAY))).toBe("stale claim");
  });

  it("a Progress: on dev keeps an item in progress after partial PRs; Closes: makes it done", () => {
    const fromLog = factsFromCommits([
      {
        commit: "c2",
        time: NOW - DAY,
        subject: "",
        trailers: [{ key: "Progress", value: "f01-001 part 2" }],
      },
      {
        commit: "c1",
        time: NOW - 3 * DAY,
        subject: "",
        trailers: [{ key: "Progress", value: "F01-001 part 1" }],
      },
    ]);
    expect(statusOf([item("F01-001")], [], facts(fromLog))["F01-001"]).toBe("in progress");
    const closed = factsFromCommits([
      { commit: "c3", time: NOW, subject: "", trailers: [{ key: "Closes", value: "F01-001" }] },
    ]);
    expect(statusOf([item("F01-001")], [], facts(closed))["F01-001"]).toBe("done");
  });

  it("an answered question no longer blocks; an unreadable integration branch is unknown", () => {
    expect(
      statusOf([item("F01-001")], [question("Q-001", "F01-001", "2026-10-10")], facts())["F01-001"],
    ).toBe("ready");
    expect(statusOf([item("F01-001")], [], facts({ ref: null }))["F01-001"]).toBe("unknown");
  });
});

describe("questions", () => {
  it("are ranked by what they block, through depends:", () => {
    const items = [item("F01-001"), item("F01-002", "depends: [F01-001]\n"), item("F01-003")];
    expect(blockedBy(question("Q-001", "F01-001"), items)).toEqual(["F01-001", "F01-002"]);
    const ranked = rankQuestions(
      [
        question("Q-002", "F01-003"),
        question("Q-001", "F01-001"),
        question("Q-003", "F01-003", "2026-10-01"),
      ],
      items,
    );
    expect(ranked.map((r) => r.question.id)).toEqual(["Q-001", "Q-002"]);
  });
});

describe("rendering", () => {
  it("groups by milestone, feature and persona, and renders JSON and HTML", () => {
    const items = [item("F01-001", "personas: [@attendee]\njourneys: [J1]\n"), item("X-001")];
    const statuses = deriveStatuses(items, [], facts(), 7);
    const report = { ref: "origin/dev", notes: [], statuses, questions: [], journeys: [] };
    const text = renderText(report, { journeys: true }).join("\n");
    expect(text).toContain("By milestone");
    expect(text).toContain("By feature");
    expect(text).toContain("@attendee");
    expect(text).toContain("J1 — 0/1 done");
    expect(renderText(report, { ready: true }).join("\n")).toContain("Ready (2)");
    expect((toJson(report) as { items: unknown[] }).items).toHaveLength(2);
    expect(renderHtml(report, "now")).toContain("<title>Plan status</title>");
  });
});

describe("gatherFacts against a real repository", () => {
  function repo(): { d: string; now: number; tip: string } {
    const d = initRepo(tempDir());
    dirs.push(d);
    for (const n of [1, 2, 3, 4, 5])
      write(
        d,
        `docs/plan/items/F01-00${n}-x.md`,
        `---\nid: F01-00${n}\ntitle: x${n}\nrequirements: [F01-R0${n}]\n---\n`,
      );
    const now = Math.floor(Date.now() / 1000);
    commit(d, "a\n\nCloses: F01-001", now - 60 * DAY);
    const tip = commit(d, "b\n\nProgress: F01-002 half", now - 2 * DAY);
    sh(d, ["remote", "add", "origin", d]);
    sh(d, ["update-ref", "refs/remotes/origin/dev", tip]);
    return { d, now, tip };
  }
  /** A commit on top of `parent` (via a scratch branch), returning its sha. */
  function commitOn(d: string, parent: string, message: string, time: number): string {
    sh(d, ["checkout", "-q", "-B", "scratch", parent]);
    const sha = commit(d, message, time);
    sh(d, ["checkout", "-q", "dev"]);
    return sha;
  }

  it("reads origin/dev, and a claim's time from its Claim: commit", () => {
    const { d, now, tip } = repo();
    const iso = new Date((now - DAY) * 1000).toISOString();
    const c = commitOn(
      d,
      tip,
      `Claim: F01-003\n\nClaimed-By: session-abc\nClaimed-At: ${iso}`,
      now - 40 * DAY,
    );
    sh(d, ["update-ref", "refs/remotes/origin/f01-003", c]);
    const f = gatherFacts(d, "dev", now);
    expect(f.ref).toBe("origin/dev");
    expect(f.claims).toEqual([
      {
        id: "F01-003",
        branch: "f01-003",
        tip: now - 40 * DAY,
        claimedAt: now - DAY,
        claimedBy: "session-abc",
        source: "claim commit",
      },
    ]);
    const m = loadModel(d);
    expect(statusOf(m.items, m.questions, f)).toMatchObject({
      "F01-001": "done",
      "F01-002": "in progress",
      "F01-003": "in progress",
    });
  });

  it("a fresh claim branch off an old integration tip is not stale", () => {
    const { d, now } = repo();
    const old = sh(d, ["rev-parse", "HEAD~1"]).trim();
    sh(d, ["update-ref", "refs/remotes/origin/dev", old]);
    sh(d, ["update-ref", "refs/remotes/origin/f01-004", old]);
    const f = gatherFacts(d, "dev", now);
    expect(f.claims[0]).toMatchObject({ id: "F01-004", claimedAt: null, source: "unknown" });
    expect(
      deriveStatuses(loadModel(d).items, [], f, 7).find((s) => s.item.id === "F01-004"),
    ).toMatchObject({ status: "in progress" });
  });

  it("falls back to the oldest commit of the branch's own, and stales an old idle claim", () => {
    const { d, now, tip } = repo();
    const first = commitOn(d, tip, "work", now - 30 * DAY);
    sh(d, ["checkout", "-q", "-B", "scratch", first]);
    const second = commit(d, "more work", now - 20 * DAY);
    sh(d, ["checkout", "-q", "dev"]);
    sh(d, ["update-ref", "refs/remotes/origin/f01-005", second]);
    const f = gatherFacts(d, "dev", now);
    expect(f.claims[0]).toMatchObject({
      claimedAt: now - 30 * DAY,
      source: "oldest unique commit",
    });
    expect(statusOf(loadModel(d).items, [], f)["F01-005"]).toBe("stale claim");
  });

  it("a slugged branch is not a claim, and says so", () => {
    const { d, now, tip } = repo();
    sh(d, ["update-ref", "refs/remotes/origin/f01-004-slug", tip]);
    const f = gatherFacts(d, "dev", now);
    expect(f.claims).toEqual([]);
    expect(f.notes.join()).toContain("f01-004-slug is not a claim");
    expect(statusOf(loadModel(d).items, [], f)["F01-004"]).toBe("ready");
  });

  it("falls back to the local branch with no origin, and says so", () => {
    const d = initRepo(tempDir());
    dirs.push(d);
    commit(d, "a\n\nCloses: F01-001");
    const f = gatherFacts(d, "dev");
    expect(f.ref).toBe("dev");
    expect(f.notes.join()).toContain("could not ask origin");
    expect(f.closes.has("F01-001")).toBe(true);
  });
});

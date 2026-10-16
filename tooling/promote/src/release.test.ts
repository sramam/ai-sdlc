import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exampleConfig } from "../../core/src/config.test-helper.mts";
import { exec as realExec, result } from "../../core/src/exec.mts";
import type { Exec, ExecResult } from "../../core/src/exec.mts";
import {
  bumpVersion,
  latestTag,
  parseReleaseArgs,
  parseReleaseLog,
  parseTag,
  releaseNotes,
  runRelease,
} from "./release.mts";
import type { ReleaseDeps, ReleaseOptions } from "./release.mts";

describe("versions", () => {
  it("parses only tags under the prefix", () => {
    expect(parseTag("v1.2.3", "v")).toEqual([1, 2, 3]);
    expect(parseTag("1.2.3", "")).toEqual([1, 2, 3]);
    expect(parseTag("v1.2", "v")).toBeNull();
    expect(parseTag("rel/1.0.0", "v")).toBeNull();
    expect(parseTag("rel/1.0.0", "rel/")).toEqual([1, 0, 0]);
  });
  it("picks the highest version, numerically", () => {
    expect(latestTag("v0.9.0\nv0.10.0\nv0.2.5\nnope\n", "v")).toEqual({
      tag: "v0.10.0",
      version: [0, 10, 0],
    });
    expect(latestTag("", "v")).toBeNull();
  });
  it("bumps", () => {
    expect(bumpVersion([1, 2, 3], "major")).toEqual([2, 0, 0]);
    expect(bumpVersion([1, 2, 3], "minor")).toEqual([1, 3, 0]);
    expect(bumpVersion([1, 2, 3], "patch")).toEqual([1, 2, 4]);
  });
});

describe("parseReleaseArgs", () => {
  it("reads one bump, --at, --yes and --allow-unknown", () => {
    expect(parseReleaseArgs(["--minor", "--at", "abc", "--yes", "--allow-unknown"])).toEqual({
      bump: "minor",
      at: "abc",
      yes: true,
      allowUnknown: true,
    });
    expect(parseReleaseArgs([])).toEqual({ yes: false, allowUnknown: false });
  });
  it("refuses two bumps, --yes without a bump, and unknown flags", () => {
    expect(parseReleaseArgs(["--minor", "--major"])).toHaveProperty("error");
    expect(parseReleaseArgs(["--yes"])).toHaveProperty("error");
    expect(parseReleaseArgs(["--set", "1.0.0"])).toHaveProperty("error");
    expect(parseReleaseArgs(["--at"])).toHaveProperty("error");
  });
});

describe("releaseNotes", () => {
  it("groups trailers by item, marks closes, and counts what is undescribed", () => {
    const log =
      `${"1".repeat(40)}\x1fp\x1ff03-012: start\x1fProgress: F03-012 job done; email remains\n\x1e` +
      `${"2".repeat(40)}\x1fp\x1fother\x1fProgress: F04-001 form\n\x1e` +
      `${"3".repeat(40)}\x1fp\x1ff03-012: finish\x1fProgress: F03-012 email done\nCloses: F03-012\n\x1e` +
      `${"4".repeat(40)}\x1fp q\x1fMerge pull request\x1f\x1e` +
      `${"5".repeat(40)}\x1fp\x1ftypo\x1fNo-Item: fix a typo in the README\n\x1e` +
      `${"6".repeat(40)}\x1fp\x1fwip\x1f\x1e`;
    const commits = parseReleaseLog(log);
    expect(commits.map((c) => c.merge)).toEqual([false, false, false, true, false, false]);
    const notes = releaseNotes(commits, {
      tag: "v0.2.0",
      sha: "9".repeat(40),
      integration: "dev",
      previous: "v0.1.0",
      date: "2026-10-15",
    });
    expect(notes).toBe(
      [
        "v0.2.0 — 999999999999 on dev, 2026-10-15",
        "6 commit(s) since v0.1.0: 4 described, 1 merge(s), 1 with no Progress:/Closes:/No-Item:",
        "",
        "F03-012 — closed",
        "  - job done; email remains (1111111)",
        "  - email done (3333333)",
        "",
        "F04-001",
        "  - form (2222222)",
        "",
        "No item",
        "  - fix a typo in the README (5555555)",
        "",
      ].join("\n"),
    );
  });
  it("says in the notes when local-ci was not checked", () => {
    const notes = releaseNotes(
      [],
      { tag: "v1.0.0", sha: "a".repeat(40), integration: "dev", previous: null, date: "d" },
      "no local-ci status",
    );
    expect(notes).toMatch(/since the first commit/);
    expect(notes).toMatch(
      /local-ci: NOT CHECKED — released with --allow-unknown \(no local-ci status\)/,
    );
  });
});

// ─── Against real git, with a scripted GitHub ────────────────────────────────

let dir: string;
let work: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const save = (msg: string, body = "") => {
  writeFileSync(join(work, "f.txt"), `${msg}\n`);
  git(work, "add", "f.txt");
  git(work, "commit", "-q", "-m", body ? `${msg}\n\n${body}` : msg);
  return git(work, "rev-parse", "HEAD");
};
const publish = () => git(work, "push", "-q", "origin", "dev");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "release-test-"));
  work = join(dir, "work");
  git(dir, "init", "-q", "--bare", join(dir, "origin.git"));
  git(dir, "init", "-q", "-b", "dev", work);
  git(work, "remote", "add", "origin", join(dir, "origin.git"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const status = (state: string | null, context = "local-ci"): ExecResult =>
  result(0, JSON.stringify({ statuses: state ? [{ context, state }] : [] }));

function deps(gh: ExecResult = status("success"), tagPrefix?: string) {
  const lines: string[] = [];
  const ghCalls: string[][] = [];
  const exec: Exec = (cmd, args, opts) => {
    if (cmd === "gh") {
      ghCalls.push(args);
      return Promise.resolve(gh);
    }
    return realExec(cmd, args, opts);
  };
  const d: ReleaseDeps = {
    exec,
    root: work,
    loadConfig: async () =>
      exampleConfig((c) => {
        if (tagPrefix !== undefined) c.release = { tagPrefix };
      }),
    log: (l) => lines.push(l),
    tempDir: () => mkdtempSync(join(dir, "msg-")),
    now: () => new Date("2026-10-15T12:00:00Z"),
  };
  return { d, out: () => lines.join("\n"), ghCalls };
}

const o = (x: Partial<ReleaseOptions> = {}): ReleaseOptions => ({
  yes: false,
  allowUnknown: false,
  ...x,
});
const tagOf = (tag: string) => {
  try {
    return git(work, "rev-parse", `refs/tags/${tag}^{commit}`);
  } catch {
    return null;
  }
};

describe("runRelease", () => {
  it("plans without --yes and writes nothing; --yes tags locally and never pushes", async () => {
    save("one", "Progress: F01-001 scaffold");
    const two = save("two", "Progress: F01-001 done\nCloses: F01-001");
    publish();
    const plan = deps();
    const p = await runRelease(o({ bump: "minor" }), plan.d);
    expect(p).toMatchObject({ exit: 0, tag: "v0.1.0", sha: two, tagged: false });
    expect(tagOf("v0.1.0")).toBeNull();
    expect(plan.out()).toMatch(/F01-001 — closed/);
    expect(plan.out()).toMatch(/plan only — nothing written/);
    expect(plan.ghCalls).toEqual([["api", `repos/{owner}/{repo}/commits/${two}/status`]]);

    const cut = deps();
    const c = await runRelease(o({ bump: "minor", yes: true }), cut.d);
    expect(c).toMatchObject({ exit: 0, tag: "v0.1.0", tagged: true });
    expect(tagOf("v0.1.0")).toBe(two);
    expect(git(work, "cat-file", "-t", "refs/tags/v0.1.0")).toBe("tag");
    const message = git(work, "tag", "-l", "--format=%(contents)", "v0.1.0");
    expect(message).toMatch(/^v0\.1\.0 — /);
    expect(message).toMatch(/ {2}- done \(/);
    expect(cut.out()).toMatch(/git push origin refs\/tags\/v0\.1\.0/);
    expect(git(work, "ls-remote", "--tags", "origin")).toBe("");
  });

  it("the notes cover only the range since the previous version", async () => {
    save("one", "Progress: F01-001 first");
    publish();
    expect((await runRelease(o({ bump: "minor", yes: true }), deps().d)).exit).toBe(0);
    save("two", "Progress: F02-001 second");
    publish();
    const t = deps();
    const r = await runRelease(o({ bump: "patch" }), t.d);
    expect(r).toMatchObject({ exit: 0, tag: "v0.1.1" });
    expect(r.notes).toMatch(/1 commit\(s\) since v0\.1\.0/);
    expect(r.notes).toMatch(/F02-001/);
    expect(r.notes).not.toMatch(/F01-001/);
  });

  it("honours tagPrefix", async () => {
    save("one");
    publish();
    const r = await runRelease(o({ bump: "major", yes: true }), deps(status("success"), "rel-").d);
    expect(r).toMatchObject({ exit: 0, tag: "rel-1.0.0" });
    expect(tagOf("rel-1.0.0")).not.toBeNull();
  });

  it("refuses a dirty tree", async () => {
    save("one");
    publish();
    writeFileSync(join(work, "f.txt"), "dirty\n");
    expect(await runRelease(o({ bump: "minor" }), deps().d)).toMatchObject({
      exit: 1,
      stoppedAt: "clean",
    });
  });

  it("refuses a commit not on origin/<integration>", async () => {
    save("one");
    publish();
    const local = save("unpushed");
    const r = await runRelease(o({ bump: "minor", at: local }), deps().d);
    expect(r).toMatchObject({ exit: 1, stoppedAt: "commit" });
  });

  it("refuses red with no override, and unknown unless --allow-unknown", async () => {
    save("one");
    publish();
    const red = deps(status("failure"));
    expect(await runRelease(o({ bump: "minor", allowUnknown: true }), red.d)).toMatchObject({
      exit: 1,
      stoppedAt: "local-ci",
    });
    expect(red.out()).toMatch(/no override for red/);
    for (const gh of [
      status(null),
      status("error"),
      status("pending"),
      status("success", "local-ci/allow-unknown"),
    ])
      expect(await runRelease(o({ bump: "minor" }), deps(gh).d)).toMatchObject({
        exit: 1,
        stoppedAt: "local-ci",
      });
    expect(await runRelease(o({ bump: "minor" }), deps(result(127)).d)).toMatchObject({
      exit: 2,
      stoppedAt: "local-ci",
    });
    const over = await runRelease(
      o({ bump: "minor", yes: true, allowUnknown: true }),
      deps(status(null)).d,
    );
    expect(over).toMatchObject({ exit: 0, tagged: true });
    expect(git(work, "tag", "-l", "--format=%(contents)", "v0.1.0")).toMatch(
      /local-ci: NOT CHECKED — released with --allow-unknown/,
    );
  });

  it("refuses naming a commit that already has the latest version", async () => {
    const one = save("one");
    publish();
    git(work, "tag", "v0.1.0", one);
    const t = deps();
    expect(await runRelease(o({ bump: "patch" }), t.d)).toMatchObject({
      exit: 1,
      stoppedAt: "version",
    });
    expect(t.out()).toMatch(/is already v0\.1\.0/);
  });

  it("refuses a newer version on a commit the latest version is not in", async () => {
    const one = save("one");
    const two = save("two");
    publish();
    git(work, "tag", "v1.0.0", two);
    const r = await runRelease(o({ bump: "minor", at: one }), deps().d);
    expect(r).toMatchObject({ exit: 1, stoppedAt: "version" });
    expect(r.tag).toBe("v1.1.0");
  });

  it("with no bump, reports and creates nothing", async () => {
    save("one");
    publish();
    const t = deps(status(null));
    expect(await runRelease(o(), t.d)).toMatchObject({ exit: 0, tagged: false });
    expect(t.out()).toMatch(/report only\. 1 commit\(s\) unreleased/);
    expect(t.out()).toMatch(/warn\s+local-ci\s+unknown/);
  });
});

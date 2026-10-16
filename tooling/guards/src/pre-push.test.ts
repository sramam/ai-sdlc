/**
 * `.husky/pre-push`, tripped. The promotion handoff is covered by
 * tooling/promote's git test; this file covers the rest: the plain refusals,
 * and the one exception a new project needs — the first push of main to a
 * repository that has no branch at all.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HOOK = join(import.meta.dirname, "..", "..", "..", ".husky", "pre-push");
const ZERO = "0".repeat(40);

let dir: string;
let work: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pre-push-"));
  work = join(dir, "work");
  git(dir, "init", "-q", "-b", "main", work);
  writeFileSync(join(work, "f.txt"), "one\n");
  git(work, "add", "f.txt");
  git(work, "commit", "-q", "-m", "one");
  const hooks = join(dir, "hooks");
  mkdirSync(hooks);
  copyFileSync(HOOK, join(hooks, "pre-push"));
  chmodSync(join(hooks, "pre-push"), 0o755);
  git(work, "config", "core.hooksPath", hooks);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function bare(name: string): string {
  const path = join(dir, `${name}.git`);
  git(dir, "init", "-q", "--bare", path);
  git(work, "remote", "add", name, path);
  return path;
}
function push(...args: string[]) {
  const r = spawnSync("git", ["push", ...args], { cwd: work, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("pre-push", () => {
  it("allows the first push of main to an empty repository", () => {
    bare("origin");
    const r = push("origin", "main");
    expect(r.out).toContain("first push of main to an empty repository");
    expect(r.code).toBe(0);
  });

  it("refuses main once the repository has any branch, even when main is new there", () => {
    bare("origin");
    git(work, "push", "-q", "--no-verify", "origin", "main:feature");
    const r = push("origin", "main");
    expect(r.code).toBe(1);
    expect(r.out).toContain("refusing to push main directly");
  });

  it("refuses an update of main after the first push", () => {
    bare("origin");
    expect(push("origin", "main").code).toBe(0);
    writeFileSync(join(work, "f.txt"), "two\n");
    git(work, "commit", "-q", "-am", "two");
    const r = push("origin", "main");
    expect(r.code).toBe(1);
    expect(r.out).toContain("refusing to push main directly");
  });

  it("refuses dev and staging to an empty repository: only main is the first push", () => {
    bare("origin");
    expect(push("origin", "main:dev").code).toBe(1);
    expect(push("origin", "main:staging").code).toBe(1);
  });

  it("refuses when the remote cannot be asked (could not ask is not empty)", () => {
    const sha = git(work, "rev-parse", "HEAD");
    const r = spawnSync("sh", [HOOK, "no-such-remote", "/nowhere"], {
      cwd: work,
      encoding: "utf8",
      input: `refs/heads/main ${sha} refs/heads/main ${ZERO}\n`,
    });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain("refusing to push main directly");
  });

  it("lets a feature branch through", () => {
    bare("origin");
    expect(push("origin", "main:x-001-configure").code).toBe(0);
  });
});

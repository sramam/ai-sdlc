/**
 * The promotion against real git: a work repository, a bare `origin`, and the
 * repository's own `.husky/pre-push`. GitHub and the deploy are not real — gh
 * is scripted and the "deploy" is a shell command that records where it ran.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exampleConfig } from "../../core/src/config.test-helper.mts";
import { exec as realExec, result } from "../../core/src/exec.mts";
import type { Exec } from "../../core/src/exec.mts";
import { runPromote } from "./promote.mts";
import type { PromoteDeps } from "./promote.mts";

const REPO = join(import.meta.dirname, "..", "..", "..");
const HUSKY_PRE_PUSH = join(REPO, ".husky", "pre-push");

/**
 * The change tooling/promote/README.md asks of .husky/pre-push: also allow a
 * promotion pushed as `<sha>:refs/heads/<target>` when the SHA is on
 * origin/<source>. Kept here so the suggestion is tested, not just written.
 */
const PROPOSED_PRE_PUSH = `while read -r local_ref local_sha remote_ref remote_sha; do
  case "$remote_ref" in
    refs/heads/dev | refs/heads/staging | refs/heads/main) ;;
    *) continue ;;
  esac
  target=\${remote_ref#refs/heads/}
  source=\${local_ref#refs/heads/}
  case "$source:$target" in
    dev:staging | staging:main)
      echo "pre-push: promoting $source → $target"
      continue
      ;;
  esac
  case "$target" in staging) from=dev ;; main) from=staging ;; *) from= ;; esac
  if [ -n "$from" ] && [ "$local_ref" = "$local_sha" ] &&
    git merge-base --is-ancestor "$local_sha" "refs/remotes/origin/$from" 2>/dev/null; then
    echo "pre-push: promoting origin/$from ($local_sha) → $target"
    continue
  fi
  echo "pre-push: refusing to push $target directly. Land work with /land (a PR into dev)."
  echo "  Promotion is exempt: pnpm promote:staging, pnpm promote:prod."
  exit 1
done
`;

let dir: string;
let work: string;
let remote: string;
let out: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const save = (cwd: string, msg: string) => {
  writeFileSync(join(cwd, "f.txt"), `${msg}\n`);
  git(cwd, "add", "f.txt");
  git(cwd, "commit", "-q", "-m", msg);
  return git(cwd, "rev-parse", "HEAD");
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "promote-git-"));
  remote = join(dir, "origin.git");
  work = join(dir, "work");
  out = join(dir, "out");
  mkdirSync(out);
  git(dir, "init", "-q", "--bare", remote);
  git(dir, "init", "-q", "-b", "dev", work);
  git(work, "remote", "add", "origin", remote);
  save(work, "one");
  git(work, "push", "-q", "origin", "dev", "dev:staging");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function installHook(text: string) {
  const hooks = join(dir, "hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "pre-push"), text);
  chmodSync(join(hooks, "pre-push"), 0o755);
  git(work, "config", "core.hooksPath", hooks);
}

function deps(logs: string[]): PromoteDeps {
  // Real git and sh; a scripted GitHub that reports local-ci green.
  const exec: Exec = (cmd, args, opts) =>
    cmd === "gh"
      ? Promise.resolve(
          result(0, JSON.stringify({ statuses: [{ context: "local-ci", state: "success" }] })),
        )
      : realExec(cmd, args, opts);
  return {
    exec,
    root: work,
    loadConfig: async () =>
      exampleConfig(
        (c) =>
          (c.environments = {
            staging: {
              branch: "staging",
              migrate: `echo migrated > ${out}/migrate`,
              deploy: `git rev-parse HEAD > ${out}/sha && pwd > ${out}/cwd && git status --porcelain > ${out}/status`,
            },
          }),
      ),
    log: (l) => logs.push(l),
    tempDir: () => mkdtempSync(join(dir, "tmp-")),
    removeDir: (d) => rmSync(d, { recursive: true, force: true }),
    exists: existsSync,
    httpGet: async () => ({ status: 200 }),
  };
}

const opts = { env: "staging", dryRun: false, yes: false };

describe("promote against real git", () => {
  it("deploys the exact SHA from a clean temporary checkout, then fast-forwards", async () => {
    const two = save(work, "two");
    git(work, "push", "-q", "origin", "dev");
    // The working tree sits somewhere else entirely: it must not be what is deployed.
    git(work, "checkout", "-q", "-b", "elsewhere", "origin/staging");
    installHook(PROPOSED_PRE_PUSH);
    const logs: string[] = [];
    const o = await runPromote(opts, deps(logs));
    expect(o, logs.join("\n")).toMatchObject({ exit: 0, deployed: true, pushed: true });
    expect(readFileSync(join(out, "sha"), "utf8").trim()).toBe(two);
    expect(readFileSync(join(out, "cwd"), "utf8").trim()).not.toBe(work);
    expect(readFileSync(join(out, "status"), "utf8").trim()).toBe("");
    expect(readFileSync(join(out, "migrate"), "utf8").trim()).toBe("migrated");
    expect(git(remote, "rev-parse", "refs/heads/staging")).toBe(two);
  });

  it("the current .husky/pre-push refuses the SHA push — caught by the dry run, before migrating", async () => {
    save(work, "two");
    git(work, "push", "-q", "origin", "dev");
    installHook(readFileSync(HUSKY_PRE_PUSH, "utf8"));
    const logs: string[] = [];
    const o = await runPromote(opts, deps(logs));
    if (/is-ancestor/.test(readFileSync(HUSKY_PRE_PUSH, "utf8"))) {
      // The hook has been changed to allow it; nothing left to document.
      expect(o.exit).toBe(0);
      return;
    }
    expect(o).toMatchObject({ exit: 1, stoppedAt: "push-check", deployed: false });
    expect(existsSync(join(out, "migrate"))).toBe(false);
    expect(git(remote, "rev-parse", "refs/heads/staging")).not.toBe(git(work, "rev-parse", "dev"));
  });

  it("refuses a target that is not an ancestor, with the hook allowing the push", async () => {
    // Something reached staging that dev does not have.
    git(work, "checkout", "-q", "-b", "stray", "origin/staging");
    save(work, "stray");
    git(work, "push", "-q", "origin", "stray:staging");
    git(work, "checkout", "-q", "dev");
    save(work, "two");
    git(work, "push", "-q", "origin", "dev");
    installHook(PROPOSED_PRE_PUSH);
    const logs: string[] = [];
    const o = await runPromote(opts, deps(logs));
    expect(o).toMatchObject({ exit: 1, stoppedAt: "ff" });
    expect(existsSync(join(out, "migrate"))).toBe(false);
  });
});

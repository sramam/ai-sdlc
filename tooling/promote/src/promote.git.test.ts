/**
 * The promotion against real git: a work repository, a bare `origin`, and the
 * repository's own `.husky/pre-push`. GitHub and the deploy are not real — gh
 * is scripted and the "deploy" is a shell command that records where it ran.
 *
 * The hook is tripped here, not only satisfied: every way of moving staging
 * other than `pnpm promote` is pushed at it and must be refused.
 */
import { execFileSync, spawnSync } from "node:child_process";
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
import { HANDOFF_FILE, NONCE_ENV, armPush } from "./shared.mts";

const REPO = join(import.meta.dirname, "..", "..", "..");
const HUSKY_PRE_PUSH = join(REPO, ".husky", "pre-push");

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

/** A push as somebody at a shell would make it: the exit and what the hook said. */
function shellPush(env: NodeJS.ProcessEnv, ...args: string[]) {
  const r = spawnSync("git", ["push", ...args], {
    cwd: work,
    encoding: "utf8",
    env: { ...process.env, [NONCE_ENV]: undefined, ...env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const handoffPath = () => join(work, ".git", HANDOFF_FILE);

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
    armPush: (sha, ref) => armPush(realExec, work, sha, ref),
  };
}

const opts = { env: "staging", dryRun: false, yes: false };

describe("promote against real git", () => {
  it("deploys the exact SHA from a clean temporary checkout, then fast-forwards", async () => {
    const two = save(work, "two");
    git(work, "push", "-q", "origin", "dev");
    // The working tree sits somewhere else entirely: it must not be what is deployed.
    git(work, "checkout", "-q", "-b", "elsewhere", "origin/staging");
    installHook(readFileSync(HUSKY_PRE_PUSH, "utf8"));
    const logs: string[] = [];
    const o = await runPromote(opts, deps(logs));
    expect(o, logs.join("\n")).toMatchObject({ exit: 0, deployed: true, pushed: true });
    expect(readFileSync(join(out, "sha"), "utf8").trim()).toBe(two);
    expect(readFileSync(join(out, "cwd"), "utf8").trim()).not.toBe(work);
    expect(readFileSync(join(out, "status"), "utf8").trim()).toBe("");
    expect(readFileSync(join(out, "migrate"), "utf8").trim()).toBe("migrated");
    expect(git(remote, "rev-parse", "refs/heads/staging")).toBe(two);
  });

  it("leaves no handoff behind after a promotion", async () => {
    save(work, "two");
    git(work, "push", "-q", "origin", "dev");
    installHook(readFileSync(HUSKY_PRE_PUSH, "utf8"));
    const o = await runPromote(opts, deps([]));
    expect(o.exit).toBe(0);
    expect(existsSync(handoffPath())).toBe(false);
  });
});

describe(".husky/pre-push refuses every other way to move staging and main", () => {
  let two: string;
  beforeEach(() => {
    two = save(work, "two");
    git(work, "push", "-q", "origin", "dev");
    installHook(readFileSync(HUSKY_PRE_PUSH, "utf8"));
  });
  const stagingAt = () => git(remote, "rev-parse", "refs/heads/staging");

  it("a raw SHA push, even of a commit already on origin/dev", () => {
    const before = stagingAt();
    const r = shellPush({}, "origin", `${two}:refs/heads/staging`);
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toMatch(/pre-push: refusing to push staging directly/);
    expect(stagingAt()).toBe(before);
  });

  it("a named-ref push from a local dev, and main from a local staging", () => {
    expect(shellPush({}, "origin", "dev:staging").code).not.toBe(0);
    git(work, "branch", "-f", "staging", two);
    expect(shellPush({}, "origin", "staging:main").code).not.toBe(0);
    expect(shellPush({}, "origin", "HEAD:refs/heads/main").code).not.toBe(0);
  });

  it("a push to dev, whatever handoff is lying around", async () => {
    const three = save(work, "three");
    const armed = await armPush(realExec, work, three, "refs/heads/dev");
    if ("error" in armed) throw new Error(armed.error);
    expect(shellPush({ [NONCE_ENV]: armed.nonce }, "origin", "dev").code).not.toBe(0);
    armed.disarm();
  });

  it("a nonce that does not match, and the handoff is spent by the attempt", async () => {
    const armed = await armPush(realExec, work, two, "refs/heads/staging");
    if ("error" in armed) throw new Error(armed.error);
    const r = shellPush({ [NONCE_ENV]: "guessed" }, "origin", `${two}:refs/heads/staging`);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/handoff names a different push/);
    expect(existsSync(handoffPath())).toBe(false);
    // The right nonce, now, finds nothing to match.
    expect(
      shellPush({ [NONCE_ENV]: armed.nonce }, "origin", `${two}:refs/heads/staging`).code,
    ).not.toBe(0);
  });

  it("a handoff for another SHA or another ref", async () => {
    const one = git(work, "rev-parse", "HEAD~1");
    const forOne = await armPush(realExec, work, one, "refs/heads/staging");
    if ("error" in forOne) throw new Error(forOne.error);
    expect(
      shellPush({ [NONCE_ENV]: forOne.nonce }, "origin", `${two}:refs/heads/staging`).code,
    ).not.toBe(0);
    const forStaging = await armPush(realExec, work, two, "refs/heads/staging");
    if ("error" in forStaging) throw new Error(forStaging.error);
    expect(
      shellPush({ [NONCE_ENV]: forStaging.nonce }, "origin", `${two}:refs/heads/main`).code,
    ).not.toBe(0);
  });

  it("a deletion of a protected branch", async () => {
    const armed = await armPush(realExec, work, "0".repeat(40), "refs/heads/staging");
    if ("error" in armed) throw new Error(armed.error);
    expect(shellPush({ [NONCE_ENV]: armed.nonce }, "origin", ":refs/heads/staging").code).not.toBe(
      0,
    );
  });

  it("accepts exactly the handed-off push, once", async () => {
    const armed = await armPush(realExec, work, two, "refs/heads/staging");
    if ("error" in armed) throw new Error(armed.error);
    const ok = shellPush({ [NONCE_ENV]: armed.nonce }, "origin", `${two}:refs/heads/staging`);
    expect(ok.code, ok.out).toBe(0);
    expect(stagingAt()).toBe(two);
    expect(existsSync(handoffPath())).toBe(false);
    const three = save(work, "three");
    // dev moves by a merged PR in life; here, past the hook, which refuses it.
    git(work, "push", "-q", "--no-verify", "origin", "dev");
    expect(
      shellPush({ [NONCE_ENV]: armed.nonce }, "origin", `${three}:refs/heads/staging`).code,
    ).not.toBe(0);
  });

  it("an ordinary feature branch is not its business", () => {
    git(work, "checkout", "-q", "-b", "feat/x");
    expect(shellPush({}, "origin", "feat/x").code).toBe(0);
  });
});

describe("promote, when something reached staging by another road", () => {
  it("refuses a target that is not an ancestor, with the hook allowing the push", async () => {
    // Something reached staging that dev does not have.
    git(work, "checkout", "-q", "-b", "stray", "origin/staging");
    save(work, "stray");
    git(work, "push", "-q", "origin", "stray:staging");
    git(work, "checkout", "-q", "dev");
    save(work, "two");
    git(work, "push", "-q", "origin", "dev");
    installHook(readFileSync(HUSKY_PRE_PUSH, "utf8"));
    const logs: string[] = [];
    const o = await runPromote(opts, deps(logs));
    expect(o).toMatchObject({ exit: 1, stoppedAt: "ff" });
    expect(existsSync(join(out, "migrate"))).toBe(false);
  });
});

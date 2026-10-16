import { describe, expect, it } from "vitest";
import { checkAccount, identitySnippet, runAccountsCheck } from "./accounts-check.mts";
import { result, scriptedExec } from "../../core/src/exec.mts";
import type { ExecResult } from "../../core/src/exec.mts";

const gh = { name: "GitHub", cli: "gh", check: ["auth", "status", "--active"] };
const wr = { name: "Cloudflare", cli: "wrangler", check: ["whoami"] };
const lovable = { name: "Lovable", cli: null, check: [], manual: "owner signs in at lovable.dev" };
const timedOut: ExecResult = {
  code: null,
  stdout: "",
  stderr: "",
  timedOut: true,
  notFound: false,
};

describe("identitySnippet", () => {
  it("prefers an email, then an account name, then the first line", () => {
    expect(
      identitySnippet("You are logged in with an OAuth Token, associated with the email a@b.co."),
    ).toBe("a@b.co");
    expect(
      identitySnippet("github.com\n  ✓ Logged in to github.com account sramam (keyring)"),
    ).toBe("sramam");
    expect(identitySnippet("\n  hello world\n")).toBe("hello world");
  });
});

describe("checkAccount", () => {
  it("logged in", async () => {
    const exec = scriptedExec([
      [/^gh auth/, result(0, "", "  ✓ Logged in to github.com account octo (keyring)")],
    ]);
    expect(await checkAccount(gh, exec)).toEqual({
      name: "GitHub",
      state: "logged-in",
      detail: "octo",
    });
    expect(exec.calls[0]?.opts.env?.CI).toBe("1");
  });
  it("not logged in", async () => {
    const exec = scriptedExec([
      [/^wrangler/, result(1, "You are not authenticated. Please run `wrangler login`.")],
    ]);
    expect((await checkAccount(wr, exec)).state).toBe("not-logged-in");
  });
  it("not installed", async () => {
    expect((await checkAccount(wr, scriptedExec([]))).state).toBe("not-installed");
  });
  it("a timeout is could-not-ask, never not-logged-in", async () => {
    const r = await checkAccount(wr, scriptedExec([[/^wrangler/, timedOut]]), 5000);
    expect(r).toMatchObject({ state: "could-not-ask", detail: expect.stringMatching(/prompt/) });
  });
  it("an unrecognised failure is could-not-ask, with what it said", async () => {
    const r = await checkAccount(
      wr,
      scriptedExec([[/^wrangler/, result(1, "", "getaddrinfo ENOTFOUND api.cloudflare.com")]]),
    );
    expect(r).toMatchObject({ state: "could-not-ask", detail: expect.stringMatching(/ENOTFOUND/) });
  });
  it("a manual entry prints its manual step", async () => {
    expect(await checkAccount(lovable, scriptedExec([]))).toMatchObject({
      state: "manual",
      detail: lovable.manual,
    });
  });
});

describe("runAccountsCheck", () => {
  it("prints one line per account; exits 1 on not installed", async () => {
    const lines: string[] = [];
    const exec = scriptedExec([[/^gh auth/, result(0, "account octo")]]);
    const { exit } = await runAccountsCheck([gh, wr, lovable], {
      exec,
      log: (l) => lines.push(l),
      allowUnknown: false,
    });
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/Cloudflare\s+not installed/);
    expect(lines[2]).toMatch(/Lovable\s+manual \(owner signs in/);
    expect(exit).toBe(1);
  });
  it("could-not-ask exits 1 unless --allow-unknown", async () => {
    const exec = scriptedExec([[/^wrangler/, timedOut]]);
    expect((await runAccountsCheck([wr], { exec, log: () => {}, allowUnknown: false })).exit).toBe(
      1,
    );
    expect((await runAccountsCheck([wr], { exec, log: () => {}, allowUnknown: true })).exit).toBe(
      0,
    );
  });
});

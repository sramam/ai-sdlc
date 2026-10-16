/**
 * `pnpm accounts:check [--allow-unknown]` — is every vendor CLI logged in?
 *
 * Each check runs non-interactively: stdin closed, CI=1, a timeout. A CLI that
 * stops to ask a question must come back as "could not ask (timed out waiting
 * on a prompt)", never as "not logged in" — this once sent somebody to a
 * console for a key the CLI would have made, because a probe that timed out on
 * an invisible prompt reported itself as unauthenticated.
 */
import { exec as realExec, firstLine, isEntry } from "../../core/src/exec.mts";
import type { Exec } from "../../core/src/exec.mts";
import { findRoot, loadConfig } from "../../core/src/config.mts";
import type { Account } from "../../core/src/config.mts";

export type AccountState =
  "logged-in" | "not-logged-in" | "not-installed" | "could-not-ask" | "manual";

export interface AccountResult {
  name: string;
  state: AccountState;
  detail: string;
}

export const TIMEOUT_MS = 20_000;

const NOT_LOGGED_IN =
  /not logged in|not authenticated|unauthori[sz]ed|no (?:api )?token|please (?:run|log ?in)|you are not|login required|\blogin\b.*first/i;

/** The most identifying fragment of a CLI's whoami output. */
export function identitySnippet(text: string): string {
  const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(text);
  if (email) return email[0];
  const account =
    /account\s+["']?([\w.@-]+)/i.exec(text) ??
    /logged in (?:to \S+ )?as\s+["']?([\w.@-]+)/i.exec(text);
  if (account?.[1]) return account[1];
  return firstLine(text, 60) || "no identity printed";
}

export async function checkAccount(
  account: Account,
  exec: Exec,
  timeoutMs = TIMEOUT_MS,
): Promise<AccountResult> {
  const { name } = account;
  if (!account.cli)
    return { name, state: "manual", detail: account.manual ?? "no CLI; no manual step recorded" };
  const r = await exec(account.cli, account.check, {
    timeoutMs,
    env: { ...process.env, CI: "1", NO_COLOR: "1", GH_PROMPT_DISABLED: "1" },
  });
  if (r.notFound) return { name, state: "not-installed", detail: `${account.cli} is not on PATH` };
  if (r.timedOut) {
    return {
      name,
      state: "could-not-ask",
      detail: `timed out after ${timeoutMs / 1000}s, probably waiting on a prompt`,
    };
  }
  const said = `${r.stdout}\n${r.stderr}`;
  if (r.code === 0) return { name, state: "logged-in", detail: identitySnippet(said) };
  if (NOT_LOGGED_IN.test(said)) return { name, state: "not-logged-in", detail: firstLine(said) };
  return {
    name,
    state: "could-not-ask",
    detail: `exit ${r.code}: ${firstLine(said) || "no output"}`,
  };
}

const LABEL: Record<AccountState, string> = {
  "logged-in": "logged in",
  "not-logged-in": "not logged in",
  "not-installed": "not installed",
  "could-not-ask": "could not ask",
  manual: "manual",
};

export async function runAccountsCheck(
  accounts: Account[],
  deps: { exec: Exec; log: (l: string) => void; allowUnknown: boolean; timeoutMs?: number },
): Promise<{ results: AccountResult[]; exit: number }> {
  const results = await Promise.all(
    accounts.map((a) => checkAccount(a, deps.exec, deps.timeoutMs)),
  );
  for (const r of results) {
    const cmd = accounts.find((a) => a.name === r.name);
    const how = cmd?.cli ? `${cmd.cli} ${cmd.check.join(" ")}` : "";
    deps.log(`  ${r.name.padEnd(14)} ${LABEL[r.state]} (${r.detail})${how ? `  [${how}]` : ""}`);
  }
  if (accounts.length === 0) deps.log("  no accounts configured in sdlc.config.json");
  const hard = results.some((r) => r.state === "not-logged-in" || r.state === "not-installed");
  const unknown = results.some((r) => r.state === "could-not-ask");
  if (unknown && deps.allowUnknown)
    deps.log("  --allow-unknown: could-not-ask is reported, not failed");
  return { results, exit: hard || (unknown && !deps.allowUnknown) ? 1 : 0 };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const bad = args.filter((a) => a !== "--allow-unknown");
  if (bad.length) {
    console.error(
      `unknown argument: ${bad.join(" ")}\nusage: pnpm accounts:check [--allow-unknown]`,
    );
    process.exit(1);
  }
  const root = findRoot();
  if (!root) {
    console.error("accounts:check: no sdlc.config.json above this directory");
    process.exit(1);
  }
  const config = await loadConfig(root);
  console.log("accounts:check");
  const { exit } = await runAccountsCheck(config.accounts, {
    exec: realExec,
    log: (l) => console.log(l),
    allowUnknown: args.includes("--allow-unknown"),
  });
  process.exit(exit);
}

if (isEntry(import.meta.url)) await main();

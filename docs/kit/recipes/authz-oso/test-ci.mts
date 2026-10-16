// `pnpm test`, with "could not run" reported as exit 2 instead of a failure.
// Exit 0: every test passed. Exit 1: a real failure. Exit 2: the only failures
// are COULD_NOT_RUN sentinels (the engine was unreachable). The ci step for
// this package declares `"unknownExitCodes": [2]` (README § Run the tests).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COULD_NOT_RUN = "AUTHZ-COULD-NOT-RUN"; // keep equal to src/could-not-run.ts

type Assertion = { status: string; title: string };
type FileResult = { name: string; status: string; message?: string; assertionResults: Assertion[] };

const dir = mkdtempSync(join(tmpdir(), "authz-ci-"));
const report = join(dir, "vitest.json");
const run = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "--reporter=default", "--reporter=json", `--outputFile.json=${report}`],
  { stdio: "inherit" },
);

let files: FileResult[];
try {
  files = (JSON.parse(readFileSync(report, "utf8")) as { testResults: FileResult[] }).testResults;
} catch {
  console.error("test-ci: vitest wrote no JSON report; reporting its own exit code");
  process.exit(run.status ?? 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (run.status === 0) process.exit(0);

const failed = files.flatMap((f) => f.assertionResults.filter((a) => a.status === "failed"));
const fileErrors = files.filter(
  (f) => f.status === "failed" && !f.assertionResults.some((a) => a.status === "failed"),
);
const onlySentinels =
  failed.length > 0 &&
  fileErrors.length === 0 &&
  failed.every((a) => a.title.startsWith(COULD_NOT_RUN));

if (onlySentinels) {
  console.error(`\ntest-ci: COULD NOT RUN (exit 2): ${failed.map((a) => a.title).join("; ")}`);
  process.exit(2);
}
process.exit(run.status ?? 1);

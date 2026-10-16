/**
 * **Is the thing on our port a live journey run, or one a previous run
 * abandoned?** — asked of the stack itself, never inferred from a directory.
 *
 * The sweep used to kill any listener whose working directory was this
 * checkout. That is the right answer for an orphan and the wrong one for two
 * things that share the cwd and are very much alive: a second journey run in
 * the same checkout (a `journeys test` while `journeys learn` is mid-pass), and
 * an ordinary dev server that happens to sit on a derived port. Both were
 * `SIGKILL`ed as orphans.
 *
 * So the host **stamps** who it is once it is ready (`stack.json`, in scratch):
 * its pid and start time, a random nonce, its control URL, and every listener
 * on its ports with that process's start time. A later sweep then has three
 * questions, each with three answers:
 *
 * | | yes | no | could not ask |
 * | --- | --- | --- | --- |
 * | does the host answer its control channel with its nonce? | **live** — refuse, `JOURNEY-005` | nothing listens: **abandoned** | a timeout: refuse, `JOURNEY-007` |
 * | did that abandoned stack record this listener? | maybe kill | refuse, `JOURNEY-006` | — |
 * | is its start time still the recorded one? | **kill** | a reused pid: refuse, `JOURNEY-006` | `ps` cannot say: refuse, `JOURNEY-006` |
 *
 * Only the last row's *yes* sends a signal. A listener nobody recorded — the
 * dev server, or an orphan of a run killed before it was ready — is named and
 * left for a person, which costs one `kill` by hand rather than somebody's work.
 */
import { spawnSync } from "node:child_process";
import type { StackStamp } from "./stamp.mts";

/** A process's start time as `ps` prints it, or null when it cannot say. Compared as a string. */
export function processStarted(pid: number): string | null {
  const r = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  const out = r.status === 0 ? r.stdout.trim() : "";
  return out || null;
}

export type HostAnswer =
  /** Something answered HTTP on the control port; pid and nonce when it is a host that says. */
  | { kind: "answered"; pid?: number; nonce?: string }
  /** Nothing is listening there. */
  | { kind: "refused" }
  /** It could not be asked: a timeout, or an error that says neither. */
  | { kind: "unreachable"; why: string };

/** The host's own answer to "who are you?", `GET /whoami`. */
export const WHOAMI_PATH = "/whoami";

const ASK = `
const url = process.argv[1];
fetch(url, { signal: AbortSignal.timeout(Number(process.argv[2])) }).then(
  async (r) => {
    let body = {};
    try { body = await r.json(); } catch {}
    console.log(JSON.stringify({ kind: "answered", pid: body.pid, nonce: body.nonce }));
  },
  (e) => {
    const code = e?.cause?.code ?? e?.name ?? String(e);
    const gone = ["ECONNREFUSED", "ECONNRESET", "EADDRNOTAVAIL"].includes(code);
    console.log(JSON.stringify(gone ? { kind: "refused" } : { kind: "unreachable", why: String(code) }));
  },
);`;

/**
 * Ask a host who it is — **synchronously**, because the sweep runs inside a
 * Playwright config, which is not async. A child `node` makes one fetch.
 */
export function askHost(controlUrl: string, timeoutMs = 3_000): HostAnswer {
  const r = spawnSync(
    process.execPath,
    ["-e", ASK, `${controlUrl}${WHOAMI_PATH}`, String(timeoutMs)],
    {
      encoding: "utf8",
      timeout: timeoutMs + 5_000,
    },
  );
  try {
    return JSON.parse(r.stdout.trim()) as HostAnswer;
  } catch {
    return { kind: "unreachable", why: r.error?.message ?? `the probe exited ${r.status}` };
  }
}

export type Ownership =
  | { kind: "live"; who: string }
  | { kind: "abandoned"; stamp: StackStamp }
  | { kind: "unrecorded" }
  | { kind: "could-not-ask"; why: string };

/** What the stamp and the host's answer say about the stack this checkout last ran. */
export function judgeOwnership(
  stamp: StackStamp | null,
  ask: (controlUrl: string) => HostAnswer = askHost,
): Ownership {
  if (!stamp?.nonce || !stamp.controlUrl || !stamp.pid) return { kind: "unrecorded" };
  const answer = ask(stamp.controlUrl);
  if (answer.kind === "refused") return { kind: "abandoned", stamp };
  if (answer.kind === "unreachable")
    return { kind: "could-not-ask", why: `${stamp.controlUrl} did not answer (${answer.why})` };
  if (answer.pid === stamp.pid && answer.nonce === stamp.nonce)
    return { kind: "live", who: `journey stack pid ${stamp.pid} (${stamp.name})` };
  // Somebody answers there and it is not the stamped host: a newer run still
  // starting, or another server. Alive either way.
  return {
    kind: "live",
    who: `whatever answers on ${stamp.controlUrl}${answer.pid ? ` (pid ${answer.pid})` : ""}`,
  };
}

/** May this listener be killed as part of an abandoned stack? Why not, when not. */
export function recordedBy(
  stamp: StackStamp,
  pid: number,
  startedOf: (pid: number) => string | null = processStarted,
): { kill: true } | { kill: false; why: string } {
  const recorded = stamp.owned?.find((o) => o.pid === pid);
  if (!recorded) return { kill: false, why: "the abandoned journey stack did not record it" };
  const started = startedOf(pid);
  if (started === null) return { kill: false, why: "its start time cannot be read" };
  if (started !== recorded.started)
    return { kill: false, why: `it started ${started}, not ${recorded.started}: a reused pid` };
  return { kill: true };
}

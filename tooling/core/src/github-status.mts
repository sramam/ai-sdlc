/**
 * When a git command fails to reach GitHub, say whose problem it is.
 *
 * GitHub publishes its status at githubstatus.com. After a network-shaped git
 * failure, `diagnoseGitFailure` reads it and returns one line: GitHub reports
 * an incident (wait for it), GitHub reports all operational (the problem is
 * between this machine and github.com, with the fix that matches the error),
 * or the status page itself could not be asked. A git failure that is not
 * about the network (a rejected push, a missing ref) gets no diagnosis.
 */

export const STATUS_URL = "https://www.githubstatus.com/api/v2/summary.json";

/** The components a git or `gh` failure depends on. */
const RELEVANT = ["Git Operations", "API Requests", "Pull Requests"];

export type GithubStatus =
  | { state: "operational" }
  | { state: "degraded"; summary: string }
  | { state: "could-not-ask"; reason: string };

interface Summary {
  status?: { indicator?: string; description?: string };
  components?: { name?: string; status?: string }[];
  incidents?: { name?: string; status?: string }[];
}

/** Reads a status summary (the JSON githubstatus.com serves). */
export function readStatus(summary: Summary): GithubStatus {
  const degraded = (summary.components ?? []).filter(
    (c) => c.name && RELEVANT.includes(c.name) && c.status && c.status !== "operational",
  );
  const incidents = (summary.incidents ?? []).filter((i) => i.status !== "resolved");
  if (!degraded.length && !incidents.length) return { state: "operational" };
  const parts = [
    ...degraded.map((c) => `${c.name}: ${(c.status ?? "").replace(/_/g, " ")}`),
    ...incidents.map((i) => `incident "${i.name}" (${i.status})`),
  ];
  return { state: "degraded", summary: parts.join("; ") };
}

export type FetchStatus = () => Promise<GithubStatus>;

export const fetchGithubStatus: FetchStatus = async () => {
  try {
    const res = await fetch(STATUS_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok)
      return { state: "could-not-ask", reason: `githubstatus.com answered ${res.status}` };
    return readStatus((await res.json()) as Summary);
  } catch (e) {
    return { state: "could-not-ask", reason: `githubstatus.com: ${(e as Error).message}` };
  }
};

/** A git error that came from the network rather than from the repository. */
export function isNetworkFailure(stderr: string): boolean {
  return /unable to access|RPC failed|SSL|HTTP2|HTTP\/2|Could not resolve host|Connection (?:timed out|reset|refused)|Operation timed out|early EOF|the remote end hung up|returned error: (?:408|429|5\d\d)|timed out/i.test(
    stderr,
  );
}

/** The local fix that matches the error, when there is one. */
export function localHint(stderr: string): string {
  if (/HTTP2|HTTP\/2|framing layer/i.test(stderr))
    return "HTTP/2 is failing on this connection: `git config http.version HTTP/1.1`, or a different network";
  if (/RPC failed|returned error: 408|early EOF|hung up/i.test(stderr))
    return "the upload was cut off: `git config http.postBuffer 524288000` and retry, or push over SSH";
  if (/SSL/i.test(stderr))
    return "the TLS connection was dropped: check a VPN, proxy or filter in the way, or retry on another network";
  if (/Could not resolve host/i.test(stderr))
    return "DNS cannot resolve github.com: check the connection";
  return "retry, or try another network";
}

/**
 * The line to print after a failed git command, or null when the failure is
 * not about the network.
 */
export async function diagnoseGitFailure(
  stderr: string,
  status: FetchStatus = fetchGithubStatus,
): Promise<string | null> {
  if (!isNetworkFailure(stderr)) return null;
  const s = await status();
  if (s.state === "degraded")
    return `GitHub reports a problem (${s.summary}); retry when githubstatus.com shows it resolved`;
  if (s.state === "operational")
    return `GitHub reports all systems operational, so the failure is between this machine and github.com: ${localHint(stderr)}`;
  return `could not ask GitHub's status (${s.reason}); ${localHint(stderr)}`;
}

import { describe, expect, it } from "vitest";
import { diagnoseGitFailure, isNetworkFailure, localHint, readStatus } from "./github-status.mts";
import type { GithubStatus } from "./github-status.mts";

const component = (name: string, status = "operational") => ({ name, status });
const ALL_OK = {
  status: { indicator: "none", description: "All Systems Operational" },
  components: [component("Git Operations"), component("API Requests"), component("Copilot")],
  incidents: [],
};

describe("readStatus", () => {
  it("is operational when every component git needs is, and no incident is open", () => {
    expect(readStatus(ALL_OK)).toEqual({ state: "operational" });
  });
  it("ignores components git does not depend on", () => {
    expect(readStatus({ ...ALL_OK, components: [component("Copilot", "major_outage")] })).toEqual({
      state: "operational",
    });
  });
  it("names a degraded component and an open incident", () => {
    const s = readStatus({
      components: [component("Git Operations", "degraded_performance")],
      incidents: [{ name: "Slow pushes", status: "investigating" }],
    });
    expect(s).toEqual({
      state: "degraded",
      summary: 'Git Operations: degraded performance; incident "Slow pushes" (investigating)',
    });
  });
});

describe("diagnoseGitFailure", () => {
  const status = (s: GithubStatus) => async () => s;
  const HTTP2 =
    "fatal: unable to access 'https://github.com/x/y.git/': Error in the HTTP2 framing layer";
  const PUSH_408 = "error: RPC failed; HTTP 408 curl 22 The requested URL returned error: 408";

  it("says nothing for a failure that is not about the network", async () => {
    let asked = false;
    const r = await diagnoseGitFailure("! [rejected] HEAD -> x (non-fast-forward)", async () => {
      asked = true;
      return { state: "operational" };
    });
    expect(r).toBeNull();
    expect(asked).toBe(false);
  });

  it("blames the local path when GitHub reports all operational, with the matching fix", async () => {
    expect(await diagnoseGitFailure(HTTP2, status({ state: "operational" }))).toMatch(
      /all systems operational.*http\.version HTTP\/1\.1/,
    );
    expect(await diagnoseGitFailure(PUSH_408, status({ state: "operational" }))).toMatch(
      /upload stalled.*push over SSH/,
    );
  });

  it("points at GitHub when it reports a problem", async () => {
    expect(
      await diagnoseGitFailure(
        HTTP2,
        status({ state: "degraded", summary: "Git Operations: partial outage" }),
      ),
    ).toMatch(/^GitHub reports a problem \(Git Operations: partial outage\)/);
  });

  it("says when the status page itself could not be asked, never that all is well", async () => {
    const r = await diagnoseGitFailure(
      HTTP2,
      status({ state: "could-not-ask", reason: "offline" }),
    );
    expect(r).toMatch(/^could not ask GitHub's status \(offline\)/);
  });
});

describe("isNetworkFailure and localHint", () => {
  it("recognises the errors seen in practice", () => {
    for (const e of [
      "LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443",
      "Error in the HTTP2 framing layer",
      "error: RPC failed; HTTP 408 curl 22",
      "Could not resolve host: github.com",
    ])
      expect(isNetworkFailure(e), e).toBe(true);
    expect(isNetworkFailure("fatal: couldn't find remote ref nope")).toBe(false);
  });
  it("matches a fix to each", () => {
    expect(localHint("SSL_ERROR_SYSCALL")).toMatch(/VPN, proxy or filter/);
    expect(localHint("Could not resolve host: github.com")).toMatch(/DNS/);
  });
});

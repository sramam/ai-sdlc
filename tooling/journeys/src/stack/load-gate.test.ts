import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECORDING_PROCESSES,
  loadCeiling,
  otherCheckoutsRecording,
  verdict,
} from "./load-gate.mts";

/**
 * **The rule was prose and nothing implemented it** (#1021).
 *
 * `agents.md` states the precondition for a learning pass *and* the form it
 * must take — *"as a precondition in the command, not a check you then act
 * on"* — and `os.loadavg()` appeared nowhere in `scripts/` or `e2e/`. Every
 * pass ever started was somebody reading `uptime` and then starting, which is
 * the third line describing exactly what must not happen.
 *
 * The gap between the reading and the start is the whole point, because a
 * learning pass is not steady: it compiles, walks a step, then sits through
 * the dwell. **The quietest moment of a pass is indistinguishable from an
 * idle machine**, and it is the worst moment to start.
 */

const nobody = () => null;

describe("the load precondition", () => {
  it("lets a quiet machine record", () => {
    expect(verdict(3.2, 10, [], null)).toEqual({ kind: "go" });
  });

  it("refuses a busy one, naming the reading and the ceiling", () => {
    const v = verdict(33.9, 10, [], null);
    expect(v.kind).toBe("stop");
    expect(v.kind === "stop" && v.why).toContain("33.9");
    expect(v.kind === "stop" && v.why).toContain("over 12");
  });

  /**
   * The documented 12 is `cores + 2` on the 10-core laptop the rule was
   * written on. Derived rather than hard-coded, so it stays proportionate on
   * a machine that is not that one — a constant would be a number meaning
   * something different everywhere else.
   */
  it("reproduces the documented 12 on ten cores, and scales", () => {
    expect(loadCeiling(10)).toBe(12);
    expect(verdict(13, 10, [], null).kind).toBe("stop");
    expect(verdict(13, 32, [], null).kind).toBe("go");
  });

  /**
   * The sharper of the two refusals: two passes can photograph each other's
   * steps mid-flight, and the wrong mask that results is permanent because
   * the union only grows.
   */
  it("refuses while another checkout is recording, naming it", () => {
    const v = verdict(1.0, 10, ["/repo/.claude/trees/j35"], null);
    expect(v.kind).toBe("stop");
    expect(v.kind === "stop" && v.why).toContain("j35");
  });

  /**
   * **`cannot-ask` allows**, and says so. A platform reporting no load
   * average must not make recording impossible: being wrong that way costs
   * one contended run, and being wrong the other way is a suite nobody can
   * run at all.
   */
  it("allows when the platform reports no load average, and says so", () => {
    const v = verdict(0, 10, [], null);
    expect(v.kind).toBe("cannot-ask");
    expect(v.kind === "cannot-ask" && v.why).toContain("no load average");
  });

  /**
   * Zero is read as unreadable rather than as idle. Both produce the same
   * number, and *idle* is the flattering reading — which is the one this
   * whole gate exists because somebody takes.
   */
  it("does not treat zero as a quiet machine", () => {
    expect(verdict(0, 10, [], null).kind).not.toBe("go");
  });

  it("can always be satisfied, and the reason is required to be non-empty", () => {
    expect(verdict(88.1, 10, ["/repo/other"], "re-recording J23 alone").kind).toBe("go");
  });
});

describe("who else is recording", () => {
  const ours = "/repo";
  const pids = (n: number[]) => () => n;

  it("names another checkout", () => {
    expect(otherCheckoutsRecording(ours, () => "/repo/.claude/trees/j35", pids([101]))).toEqual([
      "/repo/.claude/trees/j35",
    ]);
  });

  it("does not count our own run", () => {
    expect(otherCheckoutsRecording(ours, () => ours, pids([101]))).toEqual([]);
  });

  /**
   * **An unattributable process is not counted**, and that is the opposite of
   * the port sweep's rule one file over — deliberately. There, unknown means
   * *unsafe to kill*; here the consequence is refusing somebody's run, and a
   * gate that refuses on a process nobody can place is one people route
   * around.
   */
  it("does not refuse on a process it cannot place", () => {
    expect(otherCheckoutsRecording(ours, nobody, pids([101, 102]))).toEqual([]);
  });

  it("reports one checkout once, however many processes it has", () => {
    expect(
      otherCheckoutsRecording(ours, () => "/repo/.claude/trees/j35", pids([101, 102, 103])),
    ).toEqual(["/repo/.claude/trees/j35"]);
  });
});

describe("configured recording process names", () => {
  it("asks only the names it is given", () => {
    const asked: string[] = [];
    const probe = (name: string) => {
      asked.push(name);
      return name === "my-recorder" ? [7] : [];
    };
    expect(otherCheckoutsRecording("/repo", () => "/other", probe, ["my-recorder"])).toEqual([
      "/other",
    ]);
    expect(asked).toEqual(["my-recorder"]);
  });

  it("defaults to door_nexa's two", () => {
    const asked: string[] = [];
    otherCheckoutsRecording(
      "/repo",
      () => null,
      (name) => (asked.push(name), []),
    );
    expect(asked).toEqual([...DEFAULT_RECORDING_PROCESSES]);
  });
});

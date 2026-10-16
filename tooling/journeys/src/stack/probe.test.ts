import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Attempt,
  maskFiles,
  probeStack,
  readAttempt,
  refusal,
  restoreMasks,
  snapshotMasks,
} from "./probe.mts";

/**
 * The decision #550 turns on, asserted without a network or a database.
 *
 * The learning command (step 4) cannot be unit tested — it spawns a stack and runs
 * Playwright three times — so the part that *decides* lives here and is
 * exercised directly. That split is the point: the expensive command keeps the
 * orchestration and none of the judgement.
 */

/** Node wraps the real error in `cause`, which is where the code has to be read. */
const connError = (code: string): Attempt => ({
  error: Object.assign(new TypeError("fetch failed"), { cause: { code } }),
});

describe("reading one liveness probe", () => {
  /**
   * **The inversion that would have made this check useless.** The control
   * channel serves only `POST /reset` and answers `404` to a liveness `GET`, so
   * reading a 404 as *down* would abort every pass of every run and make the
   * stack look as though it always dies.
   */
  it("reads any HTTP status as up, including the 404 the control channel returns", () => {
    expect(readAttempt({ status: 404 })).toBe("up");
    expect(readAttempt({ status: 200 })).toBe("up");
    expect(readAttempt({ status: 500 })).toBe("up");
  });

  it("reads a refused or reset connection as down", () => {
    expect(readAttempt(connError("ECONNREFUSED"))).toBe("down");
    expect(readAttempt(connError("ECONNRESET"))).toBe("down");
    expect(readAttempt(connError("EPIPE"))).toBe("down");
  });

  /**
   * The third answer, and the reason it is not folded into `down`: a timeout is
   * not a claim about the process. It is still acted on the same way, because
   * discarding a pass is recoverable and a poisoned mask is not — but it is
   * *reported* differently, and that is what sends somebody to the right place.
   */
  it("reads a timeout as unreadable rather than down", () => {
    expect(readAttempt({ error: new DOMException("timed out", "TimeoutError") })).toBe(
      "unreadable",
    );
    expect(readAttempt(connError("ETIMEDOUT"))).toBe("unreadable");
    expect(readAttempt({ error: new Error("something else entirely") })).toBe("unreadable");
  });

  it("finds a code Node did not wrap", () => {
    expect(readAttempt({ error: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) })).toBe(
      "down",
    );
  });
});

describe("probing until something is conclusive", () => {
  const noSleep = async (): Promise<void> => {};

  it("stops at the first conclusive answer rather than spending the budget", async () => {
    let calls = 0;
    const verdict = await probeStack(
      async () => {
        calls++;
        return { status: 404 };
      },
      { attempts: 3, sleep: noSleep },
    );
    expect(verdict).toBe("up");
    expect(calls, "a conclusive answer must not be retried").toBe(1);
  });

  it("does not retry a down verdict either", async () => {
    let calls = 0;
    const verdict = await probeStack(
      async () => {
        calls++;
        return connError("ECONNREFUSED");
      },
      { attempts: 3, sleep: noSleep },
    );
    expect(verdict).toBe("down");
    expect(calls).toBe(1);
  });

  /**
   * The retry exists for exactly one answer, so that a loaded machine does not
   * cost a learning pass — and a later attempt is allowed to change the verdict.
   */
  it("retries only unreadable, and takes a later conclusive answer", async () => {
    const script: Attempt[] = [
      { error: new DOMException("t", "TimeoutError") },
      { error: new DOMException("t", "TimeoutError") },
      { status: 404 },
    ];
    let calls = 0;
    const verdict = await probeStack(async () => script[calls++]!, { attempts: 3, sleep: noSleep });
    expect(verdict).toBe("up");
    expect(calls).toBe(3);
  });

  it("gives up as unreadable when the budget runs out", async () => {
    let calls = 0;
    const verdict = await probeStack(
      async () => {
        calls++;
        return { error: new DOMException("t", "TimeoutError") };
      },
      { attempts: 3, sleep: noSleep },
    );
    expect(verdict).toBe("unreadable");
    expect(calls).toBe(3);
  });
});

describe("putting the masks back", () => {
  let dir: string;

  const mask = (rel: string, body: string): string => {
    const at = join(dir, rel);
    mkdirSync(join(at, ".."), { recursive: true });
    writeFileSync(at, body);
    return at;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "journey-stack-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds masks at any depth and ignores everything else", () => {
    mask("J1/admin/happy/snapshots/01-a.png.mask.json", "{}");
    mask("J1/admin/happy/snapshots/02-b.png.mask.json", "{}");
    writeFileSync(join(dir, "J1/admin/happy/snapshots/01-a.png"), "not json");
    writeFileSync(join(dir, "J1/admin/happy/README.md"), "#");

    expect(maskFiles(dir).map((f) => f.slice(dir.length + 1))).toEqual([
      "J1/admin/happy/snapshots/01-a.png.mask.json",
      "J1/admin/happy/snapshots/02-b.png.mask.json",
    ]);
  });

  /** The whole point: a box learned over a broken stack is undone, exactly. */
  it("reverts a mask the pass grew", () => {
    const at = mask("J/p/happy/snapshots/01-a.png.mask.json", '{"boxes":[]}');
    const before = snapshotMasks(dir);

    writeFileSync(at, '{"boxes":[{"x":0,"y":0,"width":1280,"height":700}]}');
    const undone = restoreMasks(dir, before);

    expect(readFileSync(at, "utf8")).toBe('{"boxes":[]}');
    expect(undone.reverted).toEqual(["J/p/happy/snapshots/01-a.png.mask.json"]);
    expect(undone.removed).toEqual([]);
  });

  /**
   * A mask the bad pass **created** has no snapshot entry. Leaving it would be a
   * box list nobody learned deliberately, surviving as though somebody had.
   */
  it("removes a mask the pass created", () => {
    mask("J/p/happy/snapshots/01-a.png.mask.json", "{}");
    const before = snapshotMasks(dir);

    mask("J/p/happy/snapshots/02-new.png.mask.json", '{"boxes":[1]}');
    const undone = restoreMasks(dir, before);

    expect(maskFiles(dir).map((f) => f.slice(dir.length + 1))).toEqual([
      "J/p/happy/snapshots/01-a.png.mask.json",
    ]);
    expect(undone.removed).toEqual(["J/p/happy/snapshots/02-new.png.mask.json"]);
  });

  /** A restore that could only revert and remove would leave a hole. */
  it("restores a mask the pass deleted", () => {
    const at = mask("J/p/happy/snapshots/01-a.png.mask.json", '{"boxes":[]}');
    const before = snapshotMasks(dir);

    rmSync(at);
    const undone = restoreMasks(dir, before);

    expect(readFileSync(at, "utf8")).toBe('{"boxes":[]}');
    expect(undone.reverted).toEqual(["J/p/happy/snapshots/01-a.png.mask.json"]);
  });

  /**
   * **An untouched journey is not reported as reverted.** A run selects one
   * journey with `--journey`, so every other mask in the tree is byte-identical
   * — and a restore claiming to have undone all of them would make the refusal
   * unreadable and hide which journey was actually affected.
   */
  it("says nothing about masks the pass did not touch", () => {
    mask("J1/p/happy/snapshots/01-a.png.mask.json", '{"a":1}');
    const at = mask("J2/p/happy/snapshots/01-a.png.mask.json", '{"b":1}');
    const before = snapshotMasks(dir);

    writeFileSync(at, '{"b":2}');
    const undone = restoreMasks(dir, before);

    expect(undone.reverted).toEqual(["J2/p/happy/snapshots/01-a.png.mask.json"]);
    expect(undone.removed).toEqual([]);
  });

  it("is a no-op when the pass changed nothing", () => {
    mask("J/p/happy/snapshots/01-a.png.mask.json", '{"boxes":[]}');
    const before = snapshotMasks(dir);
    expect(restoreMasks(dir, before)).toEqual({ reverted: [], removed: [] });
  });
});

describe("the refusal", () => {
  const undone = { reverted: ["J31/common/x/snapshots/02-a.png.mask.json"], removed: [] };

  /**
   * `down` and `unreadable` send somebody to different places, so the message
   * must not read the same for both — that is the whole reason the third answer
   * is named rather than folded in.
   */
  it("distinguishes a dead stack from one it could not ask", () => {
    const dead = refusal(1, "down", undone, "http://127.0.0.1:5523");
    const quiet = refusal(1, "unreadable", undone, "http://127.0.0.1:5523");

    expect(dead).toContain("the stack died during pass 1");
    expect(quiet).toContain("cannot be established that the stack survived pass 1");
    expect(quiet).not.toContain("the stack died");
  });

  it("names everything it put back, and the issue", () => {
    const text = refusal(2, "down", { reverted: ["J1-a"], removed: ["J2-b"] }, "u");
    expect(text).toContain("restored  J1-a");
    expect(text).toContain("removed   J2-b");
    expect(text).toContain("#550");
  });

  /**
   * The screenshots used to be the half this could not undo, so the refusal
   * sent the operator to `git restore`. The learner now restores the whole
   * evidence tree (learn/evidence-backup.mts), so the refusal says so — and
   * must not send anybody to discard work by hand that is already back.
   */
  it("says the whole evidence was put back, not only the masks", () => {
    const text = refusal(1, "down", undone, "u");
    expect(text).toContain("screenshots, masks, narratives and the index");
    expect(text).not.toContain("git restore");
  });

  it("names the configured evidence root and stack", () => {
    const text = refusal(1, "down", undone, "u", {
      evidenceRoot: "e2e/evidence",
      stackName: "my-stack",
    });
    expect(text).toContain("under e2e/evidence/");
    expect(text).toContain("my-stack is not listening on u");
  });
});

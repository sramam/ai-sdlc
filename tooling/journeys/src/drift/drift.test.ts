import { describe, expect, it } from "vitest";
import { tanstackRoutes } from "../routes/tanstack.mts";
import { drift, parseExcuses } from "./drift.mts";
import type { Recording } from "./drift.mts";

const routes = tanstackRoutes("src/routes");
const recs: Recording[] = [
  { journey: "J1-browse", id: "J1", visited: ["/", "/posts", "/posts/7"] },
  { journey: "J2-settings", id: "J2", visited: ["/settings"] },
];

describe("drift", () => {
  it("names the journeys whose recordings visited a changed route", () => {
    const found = drift(["src/routes/posts.$postId.tsx"], recs, routes, "docs/journeys");
    expect(found).toEqual([
      {
        journey: "J1-browse",
        id: "J1",
        routes: ["/posts/[postId]"],
        changedFiles: ["src/routes/posts.$postId.tsx"],
      },
    ]);
  });

  it("treats the root layout as touching every journey", () => {
    expect(
      drift(["src/routes/__root.tsx"], recs, routes, "docs/journeys").map((d) => d.id),
    ).toEqual(["J1", "J2"]);
  });

  it("is satisfied by a re-record of the journey in the same range", () => {
    const changed = [
      "src/routes/__root.tsx",
      "docs/journeys/J1-browse/common/happy/snapshots/01-a.png",
    ];
    expect(drift(changed, recs, routes, "docs/journeys").map((d) => d.id)).toEqual(["J2"]);
  });

  it("reports nothing for a file that renders no route — the shared-component hole", () => {
    expect(drift(["src/components/table.tsx"], recs, routes, "docs/journeys")).toEqual([]);
  });

  it("reads `No-Rerecord: J<n> <reason>` trailers, and refuses one with no reason", () => {
    expect(parseExcuses("J2 copy in a tooltip no step opens\n\nj7   spacing only\nJ3\n")).toEqual({
      excused: [
        { id: "J2", reason: "copy in a tooltip no step opens" },
        { id: "J7", reason: "spacing only" },
      ],
      refused: ["J3"],
    });
  });
});

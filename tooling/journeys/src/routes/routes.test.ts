import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { under } from "./adapter.mts";
import { loadRouteAdapter } from "./load.mts";
import { nextAppRoutes } from "./next-app.mts";
import { tanstackRoutes } from "./tanstack.mts";

describe("TanStack Router file routes", () => {
  const t = tanstackRoutes("src/routes");
  const cases: Array<[string, string | null]> = [
    ["src/routes/__root.tsx", "/"],
    ["src/routes/index.tsx", "/"],
    ["src/routes/about.tsx", "/about"],
    ["src/routes/posts.tsx", "/posts"],
    ["src/routes/posts/index.tsx", "/posts"],
    ["src/routes/posts/route.tsx", "/posts"],
    ["src/routes/posts.$postId.tsx", "/posts/[postId]"],
    ["src/routes/posts/$postId.tsx", "/posts/[postId]"],
    ["src/routes/posts_.$postId.edit.tsx", "/posts/[postId]/edit"],
    ["src/routes/files.$.tsx", "/files/[...splat]"],
    ["src/routes/_auth.tsx", "/"],
    ["src/routes/_auth/settings.tsx", "/settings"],
    ["src/routes/_auth.settings.profile.tsx", "/settings/profile"],
    ["src/routes/(marketing)/pricing.tsx", "/pricing"],
    ["src/routes/{-$lang}/about.tsx", "/[[lang]]/about"],
    ["src/routes/posts.lazy.tsx", "/posts"],
    ["src/routes/-components/card.tsx", null],
    ["src/routes/posts/-helpers.ts", null],
    ["src/routes/routeTree.gen.ts", null],
    ["src/routes/about.test.tsx", null],
    ["src/routes/styles.css", null],
    ["src/components/card.tsx", null],
  ];
  for (const [file, route] of cases) {
    it(`${file} → ${route ?? "no route"}`, () => expect(t.routeOf(file)).toBe(route));
  }
});

describe("Next App Router routes (ported)", () => {
  const n = nextAppRoutes("apps/web/src/app");
  const cases: Array<[string, string | null]> = [
    ["apps/web/src/app/(dashboard)/layout.tsx", "/"],
    ["apps/web/src/app/(dashboard)/leases/[id]/page.tsx", "/leases/[id]"],
    ["apps/web/src/app/api/health/route.ts", null],
    ["apps/web/src/app/leases/_components/row.tsx", null],
    ["apps/web/src/app/leases/page.tsx", "/leases"],
    ["apps/web/src/lib/x.ts", null],
  ];
  for (const [file, route] of cases) {
    it(`${file} → ${route ?? "no route"}`, () => expect(n.routeOf(file)).toBe(route));
  }
});

describe("under — does a visited path fall under a route pattern", () => {
  it.each([
    ["/", "/anything/at/all", true],
    ["/posts", "/posts/12", true],
    ["/posts/[id]", "/posts/12", true],
    ["/posts/[id]", "/posts", false],
    ["/posts/[id]/edit", "/posts/12/view", false],
    ["/files/[...splat]", "/files/a/b", true],
    ["/[[lang]]/about", "/about", true],
    ["/about", "/pricing", false],
  ])("%s ⊇ %s is %s", (pattern, visited, want) => expect(under(pattern, visited)).toBe(want));
});

describe("routeFiles and loading", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "journeys-routes-")));
  for (const f of ["src/routes/index.tsx", "src/routes/-x/y.tsx", "src/routes/about.tsx"]) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), "");
  }

  it("lists only the files that render a route", () => {
    expect(tanstackRoutes().routeFiles(root)).toEqual([
      "src/routes/about.tsx",
      "src/routes/index.tsx",
    ]);
  });

  it("loads a built-in by kind, and refuses a module that is not an adapter", async () => {
    expect((await loadRouteAdapter({ kind: "next-app", dir: "app" }, root)).name).toBe("next-app");
    writeFileSync(join(root, "bad.mts"), "export default {};\n");
    await expect(loadRouteAdapter({ module: "bad.mts" }, root)).rejects.toThrow(/JOURNEY-030/);
  });
});

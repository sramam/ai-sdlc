import { describe, expect, it } from "vitest";
import { PRODUCT_SOURCE_DIRS, isProductSource, productSourceGlobs } from "./source.mts";

describe("product source", () => {
  it("is apps/ and packages/ only", () => {
    expect([...PRODUCT_SOURCE_DIRS]).toEqual(["apps", "packages"]);
    expect(productSourceGlobs).toEqual([
      "apps/**/*.{ts,tsx,mts,cts}",
      "packages/**/*.{ts,tsx,mts,cts}",
    ]);
  });

  it.each(["apps/web/src/page.tsx", "packages/db/src/index.ts", "./packages/api/src/x.mts"])(
    "counts %s",
    (p) => expect(isProductSource(p)).toBe(true),
  );

  it.each([
    "docs/kit/recipes/db-prisma/src/client.ts",
    "tooling/ci/src/ci-local.mts",
    "scripts/one-of/x.ts",
    "apps/web/vite.config.ts",
    "packages/db/README.md",
    "sdlc.config.ts",
    "appsx/a.ts",
  ])("does not count %s", (p) => expect(isProductSource(p)).toBe(false));
});

// Tokens, not values (ux.md): no hex or arbitrary colour in a component, and no
// Tailwind v3 `[--x]` shorthand (silently invalid in v4). Applies to the kit's own
// files and to every component `shadcn add` writes.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory()
      ? files(p)
      : /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f)
        ? [p]
        : [];
  });

const RULES: [string, RegExp][] = [
  ["a hex colour", /#[0-9a-fA-F]{3,8}\b/],
  ["an arbitrary colour", /\b(?:bg|text|border|ring|fill|stroke)-\[(?:#|rgb|hsl|oklch)/],
  ["a v3 custom-property shorthand", /-\[--[a-z]/],
];

describe("ui pattern check", () => {
  const all = [...files(join(root, "kit")), ...files(join(root, "components"))];
  it("finds the files it scans", () => expect(all.length).toBeGreaterThan(10));
  it.each(RULES)("no component uses %s", (_name, re) => {
    expect(
      all.filter((f) => re.test(readFileSync(f, "utf8"))).map((f) => f.slice(root.length)),
    ).toEqual([]);
  });
});

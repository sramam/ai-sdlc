/**
 * The Next.js App Router, read back into a route pattern — door_nexa's
 * `routeOf`, ported unchanged but for the directory being a parameter.
 *
 * Route groups — `(dashboard)` — are organisational and **not** part of the URL,
 * which is the one rule that makes this derivable at all. Private folders
 * (`_components`) and anything that is not a rendered file are excluded: a
 * `route.ts` serves an API path no journey photographs, and a helper beside a
 * page is the shared-component hole `adapter.mts` names.
 */
import { filesUnder, posix } from "./adapter.mts";
import type { RouteAdapter } from "./adapter.mts";

/** Files that *render* a route. `layout` and `template` wrap one, so they count. */
const RENDERED = /^(page|layout|template|loading|error|not-found|default)\.(tsx|jsx|ts|js)$/;

export function nextAppRoutes(dir = "app"): RouteAdapter {
  const prefix = `${posix(dir).replace(/\/$/, "")}/`;

  const routeOf = (file: string): string | null => {
    const path = posix(file);
    if (!path.startsWith(prefix)) return null;
    const parts = path.slice(prefix.length).split("/");
    const leaf = parts.pop()!;
    if (!RENDERED.test(leaf)) return null;
    // A private folder is never a URL segment, and a file inside one is a helper.
    if (parts.some((p) => p.startsWith("_"))) return null;
    const segments = parts.filter((p) => !(p.startsWith("(") && p.endsWith(")")));
    return "/" + segments.join("/");
  };

  return {
    name: "next-app",
    routeOf,
    routeFiles: (root) => filesUnder(root, dir).filter((f) => routeOf(f) !== null),
  };
}

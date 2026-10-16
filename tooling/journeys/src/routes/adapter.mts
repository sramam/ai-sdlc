/**
 * **Which route a source file renders** — the one framework fact drift
 * detection needs.
 *
 * `journeys drift` asks *which journeys photograph a route this branch changed*,
 * and answers it from two halves: the routes each recording **visited**
 * (`run.json`, observed in the browser) and the route each changed file
 * **renders**. The second half is a property of the router's file conventions,
 * so it lives behind this interface. Two ship:
 *
 * | | | |
 * | --- | --- | --- |
 * | `tanstack` | TanStack Router, file-based (`src/routes`) | the default |
 * | `next-app` | the Next.js App Router (`app/`) | door_nexa's, ported unchanged |
 *
 * A route is a pattern in one spelling whatever the router: `/`, `/posts`,
 * `/posts/[id]`, `/files/[...rest]`, `/[[lang]]`. `under` matches a visited
 * pathname against it.
 *
 * ## What no adapter can see, said rather than discovered
 *
 * A **shared component has no route**. A table rendered by fifteen pages maps
 * to none of them, so a change to it reports nothing. That is the honest shape:
 * the file convention is what makes a route derivable, and a component's is
 * not. Guessing importers would trade a quiet miss for a confident wrong answer.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface RouteAdapter {
  name: string;
  /** Every file under the routes directory that renders a route, repository-relative. */
  routeFiles(root: string): string[];
  /** The route pattern a repository-relative file renders, or null if it renders none. */
  routeOf(file: string): string | null;
}

/** How a project names its router in `journeys.config.mts`. */
export type RoutesConfig =
  | { kind: "tanstack" | "next-app"; dir: string }
  /** A module whose default export is a `RouteAdapter`, relative to the root. */
  | { module: string };

export const DEFAULT_ROUTES: RoutesConfig = { kind: "tanstack", dir: "src/routes" };

/** Repository-relative, forward slashes, whatever the platform. */
export const posix = (path: string): string => path.split(sep).join("/");

/** Every file under `dir`, repository-relative. Empty when `dir` does not exist. */
export function filesUnder(root: string, dir: string): string[] {
  const base = join(root, dir);
  if (!existsSync(base)) return [];
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const here = join(at, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(here);
      } else out.push(posix(relative(root, here)));
    }
  };
  walk(base);
  return out.sort();
}

/**
 * Does a concrete visited pathname fall under a route pattern?
 *
 * A dynamic segment `[id]` matches exactly one; a catch-all `[...rest]` or an
 * optional `[[x]]` matches the rest. **A pattern matches everything beneath
 * it**, which is why this is not an equality test: a layout is `/` and wraps
 * every page, so a change to the shell touches every journey that rendered
 * inside it. That is true and is the point.
 */
export function under(pattern: string, visited: string): boolean {
  const p = pattern.split("/").filter(Boolean);
  const v = visited.split("/").filter(Boolean);
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    if (seg.startsWith("[...") || seg.startsWith("[[")) return true;
    if (i >= v.length) return false;
    if (seg.startsWith("[") && seg.endsWith("]")) continue;
    if (seg !== v[i]) return false;
  }
  return true;
}

/**
 * TanStack Router's file-based routing, read back into a route pattern.
 *
 * The conventions, each a rule below:
 *
 * | file | route |
 * | --- | --- |
 * | `__root.tsx` | `/` — wraps everything |
 * | `index.tsx`, `posts/index.tsx` | `/`, `/posts` |
 * | `posts.tsx`, `posts/route.tsx` | `/posts` — a layout, so everything beneath |
 * | `posts.$postId.tsx`, `posts/$postId.tsx` | `/posts/[postId]` — flat `.` routes and directories are the same thing |
 * | `files.$.tsx` | `/files/[...splat]` |
 * | `_auth.tsx`, `_auth/settings.tsx` | `/`, `/settings` — a `_pathless` segment adds nothing to the URL |
 * | `posts_.$postId.edit.tsx` | `/posts/[postId]/edit` — a trailing `_` un-nests, and the URL is unchanged |
 * | `(group)/about.tsx` | `/about` — a route group adds nothing either |
 * | `{-$lang}/about.tsx` | `/[[lang]]/about` — optional |
 * | `posts.lazy.tsx` | `/posts` — code splitting, not a route of its own |
 * | `-components/x.tsx`, `routeTree.gen.ts`, `*.test.tsx` | none |
 *
 * **A pathless layout maps to the route that contains it, not to its
 * children**, so `_auth.tsx` reads as `/` and therefore touches every journey.
 * That is over-reporting rather than a miss, and it is the right direction: the
 * layout renders around children that can live anywhere beneath it.
 */
import { filesUnder, posix } from "./adapter.mts";
import type { RouteAdapter } from "./adapter.mts";

const EXTENSION = /\.(tsx|ts|jsx|js)$/;

/** One TanStack segment, translated; `null` when it adds nothing to the URL. */
function segment(raw: string): string | null {
  // A trailing underscore un-nests the route from its parent's layout; the URL
  // segment is the same.
  const name = raw.endsWith("_") && raw !== "_" ? raw.slice(0, -1) : raw;
  if (name === "" || name === "index" || name === "route" || name === "__root") return null;
  if (name.startsWith("_")) return null;
  if (name.startsWith("(") && name.endsWith(")")) return null;
  if (name === "$") return "[...splat]";
  if (name.startsWith("{-$") && name.endsWith("}")) return `[[${name.slice(3, -1)}]]`;
  if (name.startsWith("$")) return `[${name.slice(1)}]`;
  return name;
}

/** A `tanstack` adapter for routes under `dir`. */
export function tanstackRoutes(dir = "src/routes"): RouteAdapter {
  const prefix = `${posix(dir).replace(/\/$/, "")}/`;

  const routeOf = (file: string): string | null => {
    const path = posix(file);
    if (!path.startsWith(prefix)) return null;
    const rest = path.slice(prefix.length);
    if (!EXTENSION.test(rest)) return null;
    if (/\.(test|spec)\.[jt]sx?$/.test(rest) || rest.endsWith(".d.ts")) return null;
    if (/(^|\/)routeTree\.gen\.[jt]sx?$/.test(rest)) return null;

    const parts = rest
      .replace(EXTENSION, "")
      .replace(/\.lazy$/, "")
      .split("/");
    // A `-` prefix on a file or a folder is TanStack's "not a route" marker.
    if (parts.some((p) => p.startsWith("-"))) return null;

    const segments = parts.flatMap((part) => part.split("."));
    const url = segments.map(segment).filter((s): s is string => s !== null);
    return "/" + url.join("/");
  };

  return {
    name: "tanstack",
    routeOf,
    routeFiles: (root) => filesUnder(root, dir).filter((f) => routeOf(f) !== null),
  };
}

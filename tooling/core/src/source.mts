/**
 * Where a project's own source lives: `apps/` and `packages/`, nothing else.
 *
 * Everything else in the starter is either upstream-owned tooling (`tooling/`)
 * or documentation that happens to contain TypeScript (`docs/kit/recipes/`),
 * and counting either as product source makes "has the project written any
 * code yet" answer yes in the empty starter — so coverage ran there. One
 * definition, so ci:local and coverage cannot disagree about it.
 */

/** The top-level directories that hold product source. */
export const PRODUCT_SOURCE_DIRS = ["apps", "packages"] as const;

/** The same, as globs, for tools that take globs. */
export const productSourceGlobs: readonly string[] = PRODUCT_SOURCE_DIRS.map(
  (d) => `${d}/**/*.{ts,tsx,mts,cts}`,
);

const SOURCE_FILE = /\.(ts|tsx|mts|cts)$/;
/** Tool configuration beside the source (vite.config.ts, …) is not source. */
const CONFIG_FILE = /\.config\.(ts|mts|cts)$/;

/** Whether a repository-relative path (forward slashes) is product source. */
export function isProductSource(rel: string): boolean {
  const path = rel.replace(/^\.\//, "");
  if (!PRODUCT_SOURCE_DIRS.some((d) => path.startsWith(`${d}/`))) return false;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return SOURCE_FILE.test(name) && !CONFIG_FILE.test(name);
}

import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RouteAdapter, RoutesConfig } from "./adapter.mts";
import { nextAppRoutes } from "./next-app.mts";
import { tanstackRoutes } from "./tanstack.mts";

/** The adapter `journeys.config.mts` names — a built-in by kind, or a module of the project's. */
export async function loadRouteAdapter(routes: RoutesConfig, root: string): Promise<RouteAdapter> {
  if ("module" in routes) {
    const path = isAbsolute(routes.module) ? routes.module : join(root, routes.module);
    const mod = (await import(pathToFileURL(path).href)) as { default?: RouteAdapter };
    if (!mod.default || typeof mod.default.routeOf !== "function") {
      throw new Error(
        `JOURNEY-030: ${path} has no default export implementing RouteAdapter ` +
          "({ name, routeFiles(root), routeOf(file) })",
      );
    }
    return mod.default;
  }
  return routes.kind === "next-app" ? nextAppRoutes(routes.dir) : tanstackRoutes(routes.dir);
}

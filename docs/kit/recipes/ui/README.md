# Recipe: `ui`

shadcn/ui on Base UI with Tailwind v4: brand tokens on shadcn's contract,
the app shell (collapsible sidebar, a top bar with ⌘K and the user menu, page
header), the role switcher, and the five screen patterns of [ux.md](../../ux.md)
(list, detail, form, dashboard, empty) with the four data states. A compact
reference: the components `shadcn add` writes are not copied
here (they are generated, and regenerating beats a stale copy).

| file                                                  | is                                                                                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `components.json`                                     | what `shadcn init -b base -p nova` wrote: `"style": "base-nova"` is how the project records Base UI                     |
| `src/kit/tokens.css`                                  | the brief's accent on the contract (`--primary`, `--ring`, `--sidebar-primary`, `--chart-1`); brand names alias onto it |
| `src/kit/shell/app-shell.tsx`                         | `Sidebar collapsible="icon"`, top bar (trigger, ⌘K button, user menu), backoffice band, the command palette             |
| `src/kit/shell/role-switcher.tsx`                     | `UserMenu` (relationships most recent first, the active one checked and shown in the frame) and `RelationshipChooser`   |
| `src/kit/shell/command-palette.tsx`                   | ⌘K / Ctrl-K: every destination and every relationship switch                                                            |
| `src/kit/shell/page-header.tsx`                       | title, description, one primary action, breadcrumbs                                                                     |
| `src/kit/patterns/list.tsx`                           | `useListState(adapter)` (search and sort in the URL) and `DataTable` (TanStack Table v9, sticky header)                 |
| `src/kit/patterns/form.tsx`                           | `useCapabilityForm(schema, submit)`: RHF + `zodResolver` with the port's schema; a `Refusal.field` lands on its field   |
| `src/kit/patterns/dashboard.tsx`                      | `KpiTiles`: compact value, exact value as `title`, links to the list behind it; money as integer cents                  |
| `src/kit/patterns/detail.tsx`                         | header with status badge and actions, sections as tabs                                                                  |
| `src/kit/patterns/empty.tsx`                          | what it is, why it is empty, the one action                                                                             |
| `src/kit/patterns/data-state.tsx`                     | `DataState`: loading (a skeleton, `aria-busy`), error with retry, empty, populated                                      |
| `src/kit/demo.tsx`                                    | every pattern inside the shell; what `vite build` compiles so the built CSS can be checked                              |
| `src/kit/pattern-check.test.ts`                       | no hex or arbitrary colour, and no v3 `[--x]` shorthand, in the kit or in `components/ui`                               |
| `*.test.tsx`, `test/setup.ts`, `vitest.kit.config.ts` | one suite per pattern and the shell (jsdom); the polyfills jsdom needs, each naming who needs it                        |

## Instantiate

```bash
pnpm dlx shadcn@4.21.5 init -b base -p nova          # in the app; -t start for a new TanStack Start app
pnpm dlx shadcn@4.21.5 add sidebar dropdown-menu command dialog table input label field \
  card badge skeleton empty select tabs breadcrumb tooltip separator sheet avatar sonner alert kbd
pnpm sdlc add ui                                     # from the repo root: src/kit, test/setup.ts,
                                                     # vitest.kit.config.ts and the dependencies, into apps/web
echo '@import "./kit/tokens.css";' >> src/styles.css # the CSS init wrote
```

The kit's tests run with `pnpm exec vitest run -c vitest.kit.config.ts` (jsdom),
beside the app's own `vitest.config.ts`.

Add `"test"` to `tsconfig.app.json`'s `include` (the jest-dom matchers' types
load from `test/setup.ts`). Wrap the app in `TooltipProvider` (the sidebar's collapsed tooltips need it).
In TanStack Start, implement `SearchAdapter` with the route's `useSearch` and
`navigate({ search, replace: true })`, so list state is typed search params.
Then, after any `shadcn add`, build and check the CSS, not the diff (ux.md):

```bash
pnpm exec vite build && grep -oE '(width|height|max-width|max-height|transform-origin):--[a-z-]+' dist/**/*.css
```

## Verified

2026-10-16, in a scratch Vite app scaffolded by
`shadcn@4.21.5 init -t vite -b base -p nova` (React 19.3, @base-ui/react 1.9.0,
Tailwind 4, TypeScript 6.0, TanStack Table 9.3.1, react-hook-form 7.90.0,
@hookform/resolvers 5.9.1, vitest 3.2.4, jsdom 30):

- `vitest run`: 20 tests pass (list 5, form 4, dashboard 1, detail 1, shell 4,
  demo 1, pattern check 4); `tsc --noEmit` clean; `vite build` succeeds.
- **Proved by tripping**: routing every refusal to the form banner fails the
  field test; sorting on the stringified value fails the sort test (`"125000"`
  sorts before `"90000"`); a hex colour in a kit file fails the pattern check.
- The built CSS had no `prop:--x` declarations: the Base UI registry writes
  v4's `w-(--x)` form, so the v3-era `[--x]` trap did not reproduce. Keep the check.
- **Not verified**: rendering in a browser (layout, focus rings, the sidebar's
  collapse animation, mobile sheet), `init` inside an existing TanStack Start
  app, and the theme toggle. jsdom applies no stylesheet.

## Base UI coverage, as found (shadcn 4.21.5, `base-nova`)

| component                                                                                                            | Base UI?                 | note                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sidebar, dropdown-menu, dialog, sheet, select, tabs, tooltip, separator, avatar, input, button, breadcrumb, combobox | yes (`@base-ui/react/*`) | compose with `render`, not Radix's `asChild`                                                                                                                                                                                             |
| **command (⌘K)**                                                                                                     | **no: `cmdk`**           | cmdk 1.1.1 depends on `@radix-ui/react-dialog` (+ `react-id`, `react-primitive`, `react-compose-refs`); Radix code is in the built bundle. A Base UI ⌘K would build on `Combobox`/`Autocomplete`. ADR before shipping either way (ux.md) |
| command's `CommandDialog`                                                                                            | wraps Base UI `Dialog`   | it does not wrap its children in `<Command>`; without one, cmdk throws `Cannot read properties of undefined (reading 'subscribe')`                                                                                                       |
| sonner (toasts)                                                                                                      | n/a                      | the wrapper imports `next-themes`, while the Vite/Start template ships its own `ThemeProvider`: toasts follow the system theme, not the toggle, until the wrapper reads the app's provider                                               |
| data-table                                                                                                           | not a registry item      | `add data-table` → not found for `base-nova`; it is a guide over TanStack Table v9 (`useTable`, `tableFeatures`)                                                                                                                         |
| breadcrumb                                                                                                           | yes                      | `BreadcrumbPage` renders `role="link" aria-disabled`, so a page title and a nav link share a name in the accessibility tree                                                                                                              |
| sidebar menu button                                                                                                  | yes                      | `isActive` sets `data-active` only; the kit adds `aria-current="page"` on the link                                                                                                                                                       |
| calendar                                                                                                             | `react-day-picker`       | not Base UI; fine, it has no primitive layer to clash                                                                                                                                                                                    |

## Traps

- **`init -d` names `--preset=base-nova`, and `-p base-nova` is refused**
  (`Available presets: nova, vega, maia, lyra, mira, luma, sera, rhea`). Pass
  `-b base -p nova`; the result is `"style": "base-nova"`.
- **`add -y` does not answer an overwrite prompt**; with no terminal it exits 2.
  `-o` overwrites, which also rewrites files you customized (ux.md): review the
  diff.
- **`cn` is now an npm package** (`cn`, from shadcn-ui/cn, replacing
  `clsx` + `tailwind-merge`), and `shadcn` itself becomes a runtime dependency
  (the CSS imports `shadcn/tailwind.css`).
- **TanStack Table sorts number columns descending first**; the kit sets
  `sortDescFirst: false` so every column behaves the same.
- **Sort on the value, show the format**: `accessorFn` is the underlying value
  (cents, a date), `cell` formats it.
- **jsdom needs** `matchMedia` (the sidebar's `useIsMobile`), `ResizeObserver`
  and `scrollIntoView` (cmdk); `test/setup.ts` provides them.

## Sources (read 2026-10-16)

- [shadcn CLI](https://ui.shadcn.com/docs/cli): `init -b, --base <base>`:
  "the component library to use. (base, radix, aria)"; `-t` templates include
  `start`.
- [Components](https://ui.shadcn.com/docs/components): a `/docs/components/base/`
  section per component, beside `aria` and `radix`.
- [Data Table (Base UI)](https://ui.shadcn.com/docs/components/base/data-table):
  TanStack Table v9, `useTable({ features, data, columns })`,
  `tableFeatures({ rowSortingFeature, sortedRowModel: createSortedRowModel(), sortFns })`,
  `<table.FlexRender header={…} />`.
- Everything in the coverage table and the traps was observed in the
  scratch project, from the files `shadcn` wrote and `npm view cmdk@1.1.1 dependencies`.

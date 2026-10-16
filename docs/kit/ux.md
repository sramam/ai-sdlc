# UX and UI: competent, professional, effortless

The goal is a product that looks professional and makes the common task
effortless. Use shadcn/ui, apply its conventions
consistently, get the states right, and take clicks away.

**Discovery** happens in `/kickoff` (stage 2, PRD step 6, the design brief) and produces
`docs/requirements/ux.md`, the project's design brief. Building follows the
playbook below. Where a mockup and the brief disagree, the brief wins, and
the divergence is written down.

## What kickoff asks (PRD step 6)

Ask these questions, in batches, with recommendations. The answers become `docs/requirements/ux.md`.

### Brand and feel

1. Is there an existing brand (logo, colors, font)? If not: one accent color and
   one font, and we derive the rest.
2. Three adjectives for how it should feel: calm, fast, playful, serious,
   premium, friendly.
3. Two or three products you like using, and one you dislike, with what
   specifically.
4. Light, dark, or both? _Default: both, following the system setting, with a
   toggle._

### Users at the screen (per persona, from `personas.md`)

5. How often: daily power user, weekly, or once a month? This decides density,
   keyboard shortcuts, and how much the UI explains itself.
6. Which device and context: desktop at a desk, phone on the move, a tablet in
   the field? _Default: desktop-first, fully usable on mobile._
7. **The top three tasks per persona that must be effortless.** These get the
   fewest clicks, the best defaults and the shortcuts.
8. How skilled are they? Are they comfortable with tables, filters and bulk
   actions?

### Content and data

9. Are the main screens lists of records (tables), dashboards, documents,
   conversations or forms? This decides the screen patterns used.
10. How much data per list: tens, thousands, millions? This decides server-side
    paging and search.
11. What has to be scannable at a glance? What gets summarized as a number or a
    status?

### Constraints

12. Accessibility target. _Default: WCAG 2.2 AA._ Any users with specific needs?
13. Languages and locales: one, several, right-to-left? Date, number and
    currency formats?
14. Does each tenant need its own branding (white-label)?
15. Any mockups or Figma files? (They illustrate. The brief governs.)
16. Onboarding: how does a new user get from sign-up to their first success?
    With empty-state guidance, sample data, or a checklist?

Unknown answers take the defaults and are marked `provisional`.

## `docs/requirements/ux.md`: the design brief

```markdown
# Design brief

Feel: <3 adjectives>
References: <liked products, and what to borrow from each>
Theme: light + dark (system)
Accent: <hex>
Font: Inter | <brand font>
Density: comfortable | compact
Primary device: desktop | mobile
A11y: WCAG 2.2 AA
Locales: en-US

## Effortless tasks

@persona, task, target (≤ N clicks, keyboard path)

## Screen patterns

which screens are tables / dashboards / forms / detail

## Navigation

the shell, the sidebar sections, ⌘K

## Voice

how copy sounds; terms come from glossary.md

## Divergences

where we chose against a mockup, and why
```

## The defaults (build with these unless the brief says otherwise)

**Stack**: shadcn/ui on Base UI primitives (not Radix), Tailwind v4 (CSS-first), lucide icons, Inter or the brand
font, a theme provider that sets the class before first paint (no flash), Recharts for charts,
`sonner` for toasts, React Hook Form with the capability's Zod schema.

**Tokens, not values.** Use shadcn's token contract (`--background`, `--card`,
`--primary`, `--muted-foreground`, `--border`, `--ring`, `--chart-*`) and make
brand names aliases _onto_ it. Never write a hex value or an arbitrary color in
a component. One accent color, neutrals for everything else, and the
destructive color only for destruction.

**The shell.** A collapsible sidebar (sections from the brief), a top bar with
search or ⌘K, the user menu and the theme toggle, and one content column with a
consistent page header: title, one-line description, primary action
(right-aligned), and breadcrumbs where depth exceeds one level.

**Screen patterns.** Use a small, fixed set:

| pattern       | rules                                                                                                                                                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **list**      | a data table: search, filters and sort; state in the URL; sticky header; server paging past a few hundred rows; a row opens its record; bulk actions appear when rows are selected; columns sort on the underlying value, not the formatted one |
| **detail**    | header with status badge and actions; tabs or sections; related lists as compact tables                                                                                                                                                         |
| **form**      | single column; labels above fields; validate on blur; every error on its field, including server refusals; one primary button; disable it while submitting                                                                                      |
| **dashboard** | KPI tiles (compact numbers, exact value on hover), then charts, then "needs attention" lists. A tile links to the list behind it                                                                                                                |
| **empty**     | what this is, why it is empty, and the one action that fills it                                                                                                                                                                                 |

**Every data view has four states, designed rather than left to chance**:
loading (skeletons shaped like the content, not spinners), empty, error (what
happened, plus a retry), and the populated view.

**Effortless by default:**

- smart defaults; prefill from context; remember the last choice per user
- the top tasks from the brief are reachable in ≤ 2 clicks, and from ⌘K
- inline edit for single fields; bulk actions for repeated ones
- **undo instead of confirm** for reversible actions; confirm only what cannot
  be undone, and say exactly what will be lost
- optimistic updates where a failure is rare and visible; never for money or
  anything irreversible
- toasts confirm success briefly; errors stay inline until they are fixed
- keyboard: every action reachable, focus visible, `Esc` closes, `Enter` submits
- copy: short, the user's words (from the glossary), with no internal IDs or
  field keys in messages

**Concise and efficient**:

- no decorative illustrations, no gradients for their own sake, no animation
  that delays a task (≤ 150ms transitions)
- one primary action per screen
- whitespace over borders; borders over shadows
- comfortable density for occasional users, compact for power users (the design brief's Density line, from question 5)

**Responsive**: tables become stacked cards below 640px; the sidebar becomes a
sheet; touch targets are at least 40px on mobile.

**Accessible**: shadcn and Base UI give the semantics, so do not fight them. Check
color contrast for the accent color in both themes. Every icon-only button has
an accessible name. Use form labels, never placeholders as labels.

## Traps

- **Base UI, not Radix.** Choose Base UI when initialising shadcn, and add
  components only from its Base UI variants. Base UI components compose with a
  `render` prop, not `asChild`. ⌘K (`command`) is built on cmdk, which pulls
  in Radix's dialog ([spike-2026-10.md](spike-2026-10.md) § _Addendum_); take
  it with an ADR, or build ⌘K on Base UI's Combobox. Where a component has no
  Base UI variant, write an ADR before reaching for Radix.
- **Tailwind v3 shorthand in generated components** (`w-[--x]`; `w-[var(--x)]`
  is the v4 form) did not reproduce with shadcn on Base UI
  ([spike-2026-10.md](spike-2026-10.md) § _Addendum_); the `ui` recipe's
  `src/kit/pattern-check.test.ts` still refuses the shorthand. `@source` paths
  resolve from the CSS file, not the package root. After any `shadcn add`,
  check the built CSS, not the diff. A primitive that looks _structurally_
  wrong (no width, visible `sr-only` text) is a missing stylesheet, not a
  broken component.
- `shadcn add` rewrites imports to an alias other packages cannot resolve, and
  rewrites components it depends on. Review the diff for lost customization.
- A Radix `SelectItem`'s children are projected into the trigger, so an icon
  in an item appears twice. Check whether Base UI's Select does the same before
  drawing an adornment in an item; draw the trigger's adornment only for the
  placeholder.
- `formatMoney` everywhere a reader adds figures up; compact money
  (`$242.3K`) only on KPI tiles, with the exact figure in a tooltip.
- A schema used by a client form must not import the database package. The
  build fails, and the type check does not notice.

## Shells and role switching

Each persona group gets its own shell: a home that answers _what needs me
now_, navigation showing only what that role can reach, and the shell's own
vocabulary.

- **The backoffice is never the customer front with extra menu items.**
  Operators, support and product admins get their own shell, or their own app
  (decided in `/kickoff`), with a visibly different frame, so nobody mistakes
  where they are.
- **Role switching**: someone who holds several roles (admin in one tenant,
  member in another, customer and staff) switches through one switcher in the
  user menu, listing their relationships, most recent first, with ⌘K support.
  Switching changes the shell and the data scope together. The active role is
  always visible in the frame.
- **Choosing is a precondition, not a dropdown buried in a page.** A person with
  several relationships and no active one picks first, then enters the shell.
- **Staff acting inside a customer's account** (support) see a persistent,
  unmissable banner, and their access is time-boxed and audited (`security.md`).

## AI in the interface

Use the modes from `ai.md`, each with a consistent pattern:

| mode              | pattern                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **act / propose** | an inline proposal card: what will happen, why, with Approve, Edit and Dismiss. Completed agent actions appear in the record's history with an undo           |
| **assist**        | a sparkle action next to the field or record ("Draft", "Summarise", "Extract"); the result lands in the field as an editable suggestion, never auto-submitted |
| **see**           | an "Ask" box on dashboards and lists, answering with a number, a table or a chart from our chart components, plus "how this was calculated"                   |
| **notice**        | a "Needs attention" band on the shell's home, each item with its reason and a one-click action                                                                |
| **set up**        | AI-prompted onboarding: a guided conversation beside a live preview of the configuration it proposes, applied in one step                                     |

Always show that AI was involved, how sure it is (where that is meaningful),
and how to correct it. AI is a faster path, never the only path: everything it
can do is also reachable by hand.

## Design partners: Lovable, and Figma when necessary

Lovable is the design partner.

- **When**: in `/kickoff` once the brief exists, for the effortless tasks and the
  main screen patterns. Later, in `/spec`, for any new screen that is
  not an obvious instance of an existing pattern.
- **How**: generate the prompt from `ux.md`: the feel, references, personas,
  tasks, patterns, and the glossary terms and realistic sample data (never
  real user data). Iterate with the author until a direction is chosen.
- **What comes back into the repo**: screenshots of the chosen screens and a
  short note on what to keep, saved under
  `docs/requirements/ux/` and referenced from the brief. These are references.
- **Lovable's code is not merged.** It bypasses the port, the authorization
  engine, telemetry and tests, and may use primitives other than Base UI. The
  screens are rebuilt from our components to match the reference. If a pattern
  from a prototype is worth keeping, it becomes a component in `packages/ui`
  and a line in the brief.

**Figma, when necessary**: an existing brand or design system to honour, a
custom visual (illustrations, data visualisation, a marketing page), or a
designer who works there. Read designs through Figma's Dev Mode MCP server,
take tokens from Figma variables into the CSS tokens, and record any divergence
in the brief's Divergences section. Unverified as of 2026-10-16: that the
Dev Mode MCP server is current and how it is configured; check Figma's Dev
Mode MCP server page before relying on it.
Figma is not a gate for ordinary screens; the brief and the patterns are
enough.

## Keeping it good

- **A UI scan in `ci:local`**, added by the UI foundation item
  ([BOOTSTRAP.md](BOOTSTRAP.md)), with a ratcheting floor: the build fails
  on a regression, never on the backlog. Until it exists, the `ui` recipe's
  `src/kit/pattern-check.test.ts` covers tokens and the v3 shorthand.
- **A component viewer** (a single-file design-system page) built from the same
  tokens, so drift is visible.
- **Journeys record screenshots** of every path, and a person reviews them. The
  steps are compared with their references under learned masks in a one-pass
  test, and a person reviews every re-recording (see [testing.md](testing.md)).
- **UI review checklist** in the code review's project criteria (criterion 6,
  `.agents/skills/code-review-and-quality/project-criteria.md`) for any change
  to a screen:
  - tokens only
  - all four states present
  - errors sit on their fields
  - keyboard path works
  - nothing in the brief is contradicted

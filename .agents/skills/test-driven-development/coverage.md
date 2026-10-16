# Coverage report

**Checklist:**

1. Run `pnpm coverage --report` **in the background**; wait for it to finish.
2. Act on what it said (table below). Stop on `unchanged` or a red suite.
3. Read `git diff -- docs/quality/coverage.md`, not the whole file.
4. Rewrite `docs/quality/README.md`: what moved, and what a gap would let through.
5. Stage both documents **in the same commit** as the change that moved them.
6. Never lower a floor here. If one must fall, the reason goes in the commit that changes `sdlc.config.json`.

## Two documents, split by who writes them

|                            | written by                                                           | holds                                     |
| -------------------------- | -------------------------------------------------------------------- | ----------------------------------------- |
| `docs/quality/coverage.md` | the CLI, between `<!-- coverage:start -->` / `<!-- coverage:end -->` | every figure. Never hand-edited           |
| `docs/quality/README.md`   | you, in this skill                                                   | the reading: what moved and what it means |

## What the run can say

| output                                      | means                                                        | do                                                              |
| ------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------- |
| `unchanged … suites not run`                | nothing a figure depends on changed since the last green run | stop: nothing to write. Say so                                  |
| `wrote docs/quality/coverage.md` and exit 0 | a green, judged run; the report is stamped                   | continue                                                        |
| `[ FAIL ] … suite`                          | a test failed                                                | stop. A report from a red build measures the wrong thing        |
| `[ FAIL ] … below its floor`                | untested code arrived                                        | the finding is the untested code; say what it would let through |
| `refusing to overwrite a merged …` (exit 2) | `--unit-only`: the integration suite did not run             | run where it can. Its coverage is unknown, not zero             |
| `[ n/a  ] floors`                           | no floors declared yet                                       | fine early on; propose floors once there is code worth guarding |

## Reading the diff

- A module's **uncovered lines** rose: new code arrived untested.
- A floor's _today_ now equals its floor: the next commit fails the build.
- A floor's _today_ sits well above its floor: propose raising it to the rounded-down measurement. A floor is a ratchet, not a target.

## `docs/quality/README.md`

30 to 50 lines, rewritten wholly each time (git holds the history):

```markdown
# Quality

**Coverage: <n>% lines**, <n> uncovered, at `<sha>`. [The numbers](coverage.md).

## What moved

<two or three sentences; "unchanged" is a legitimate answer>

## What a gap would let through

<the gaps whose failure is silent, each with its number and one sentence on
what breaking there costs. Not the lowest percentages.>

## Known and deliberate

<what is low on purpose, so nobody opens a task for it>
```

Rules:

- **Never quote a floor value in prose** anywhere under `docs/` except the generated `coverage.md`. The pattern check in `@ai-sdlc/coverage` fails the build on one; link to `sdlc.config.json` instead.
- **Coverage is not correctness.** Say what a gap would let through, never only that it exists.
- A serious gap with no plan item: say it needs one. Do not file it from here.

## Report format

```
✓ docs/quality/coverage.md + README.md at <sha>
  <n>% lines (<±n> pts) · <n> uncovered (<±n>)
  Floors: <any that could rise, or are about to fail, or n/a>
```

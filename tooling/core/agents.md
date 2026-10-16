@ai-sdlc/core: Shared by every other module: the `sdlc.config.json` loader (with the module list and the upstream-owned paths), the command runner (`exec`), and the one git-command parser every guard uses.

- Keep it dependency-free: hooks run it with `node`, before `pnpm install`.
- A second parser for git commands is the bug this module exists to prevent.
- `sdlc.config.json` is data: read and validated, never imported. Add a key to `SHAPE` in `src/config.mts` and regenerate `src/config.schema.json` (`node tooling/core/src/config-schema.mts --write`).

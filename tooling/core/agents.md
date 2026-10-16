@ai-sdlc/core: Shared by every other module: the `sdlc.config.ts` loader (with the module list and the upstream-owned paths), the command runner (`exec`), and the one git-command parser every guard uses.

- Keep it dependency-free: hooks run it with `node`, before `pnpm install`.
- A second parser for git commands is the bug this module exists to prevent.

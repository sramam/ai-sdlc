# @ai-sdlc/core

Shared by every other module: the `sdlc.config.ts` loader (with the module list and the upstream-owned paths), the command runner (`exec`), and the one git-command parser every guard uses.

Upstream-owned: changed in the ai-sdlc starter, pulled with `pnpm sdlc:update`. A project that needs different behaviour replaces the module and lists it in `sdlc.config.ts` `modules.replaced` (docs/kit/starter-repo.md).

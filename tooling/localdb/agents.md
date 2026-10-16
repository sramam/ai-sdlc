@ai-sdlc/localdb: `pnpm db:local` — a PGlite database per checkout under `.localdb/<db>/`, on a port derived from the checkout path, with `dumpDataDir` snapshots. See README.md.

- **Open one connection per client.** The socket server multiplexes every
  connection onto one Postgres session, so the unnamed prepared statement and
  portal are shared: two pooled connections clobber each other and fail as
  nonsense (door_nexa met `invalid input syntax for type bigint` on a table with
  no bigint column). Prisma: `connection_limit=1` is ignored by the `pg` adapter
  — pass `max: 1` to the pool. `pg`: `new Pool({ max: 1 })`.
- **A lock naming a dead pid is stale**, cleared and said. A `busy` or
  `starting` lock, or an unreadable one, is could-not-ask; nobody guesses.
  Never delete `server.json` while `status` says running.
- **Restore and reset refuse a running database without `--force`.** `migrate`
  refuses to run if its snapshot failed: no migration without a way back.
- **Never `pkill -f server.mts`** — it reaches every worktree's databases. Use
  `pnpm db:local stop`, which signals the pid in this checkout's lock only after
  checking that pid is still our server.
- **`.localdb/` is per checkout and gitignored.** A worktree starts empty: run
  `start`, then `migrate` (or restore a snapshot copied from elsewhere).
- **Snapshots are PGlite-version specific.** A tarball written by one PGlite
  major may not load in another; after bumping `@electric-sql/pglite`, `reset`
  rather than `restore` an old snapshot.
- Not CI: the server is a detached background process that outlives the
  command. Tests start real servers in a temp dir and stop them in `afterAll`.

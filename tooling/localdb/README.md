# @ai-sdlc/localdb

`pnpm db:local` — a PGlite database per checkout, so a schema or data change in
one worktree never reaches another agent, and every change can be undone.

Each declared database is one Postgres (PGlite, WebAssembly) served over the
wire protocol by a background process, with its data in the checkout:

```
.localdb/<db>/data/          the PGlite data directory (gitignored)
.localdb/<db>/snapshots/     <label>.tar.gz
.localdb/<db>/server.json    the lock: pid, port, URL, control channel
.localdb/<db>/server.log     the background server's output
```

## Configure

```json
{
  "localdb": {
    "databases": [
      {
        "name": "app",
        "migrate": "pnpm --filter @app/db exec drizzle-kit migrate",
        "env": ["CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE"]
      }
    ]
  }
}
```

A top-level key of `sdlc.config.json`. `migrate` is the project's command; `env` names extra
variables that also get the URL.

`migrate` runs from the repository root with `DATABASE_URL` (and every name in
`env`) set to the database's URL. The ORM is the project's choice, so applying
migrations is the project's command.

## Commands

| command                          | does                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `start [db]`                     | start (every declared database when none is named); prints the `DATABASE_URL`                       |
| `stop [db]`                      | stop; SIGTERM, then SIGKILL after 15s, and says which                                               |
| `status [db]`                    | one line each: running/stopped, port, data size, last snapshot                                      |
| `url [db]`                       | print the URL; exit 1 when it is not running — `export DATABASE_URL=$(pnpm -s db:local url)`        |
| `migrate [db]`                   | snapshot `pre-migrate-<time>`, then run the `migrate` command. Refuses when stopped                 |
| `reset [db] [--force]`           | snapshot `pre-reset-<time>`, delete the data, start, migrate. Refuses while running without --force |
| `snapshot <label> [db]`          | dump the data directory, running or not. Refuses an existing label without --force                  |
| `restore <label> [db] [--force]` | put a snapshot back. Refuses while running; --force stops, restores and starts again                |
| `snapshots [db]`                 | list them                                                                                           |

A database name is required for the single-database commands only when more than
one is declared. Exit 0 = all ok, 1 = a definite failure, 3 = something could not
be asked (a busy or unreadable lock, a pid alive on a port that does not answer).

## Ports

A port is derived per checkout **and** database — a hash of the checkout path and
the name into 55000–55499 — so it is stable across restarts and different in
every worktree. It is probed by actually binding it (on 127.0.0.1, ::1 and the
wildcard), and a held port steps to the next, up to 16, saying which it skipped.
The port in use is the one in the lock, so `url` is always right even after a step.

## Snapshots

PGlite `dumpDataDir("gzip")` tarballs, one format whether the database is running
or not:

- **running**: the server dumps its own data directory when asked over its
  control channel (HTTP on 127.0.0.1, a random port and token in the lock file,
  accepting only a label). No stop, so an app connected to it keeps its connection.
- **stopped**: the CLI opens the data directory in-process and dumps it.
- **restore** moves the data aside, creates a PGlite with `loadDataDir`, checks it
  answers, then deletes what it moved aside — or puts it back on failure.

Automatic snapshots (`pre-migrate-…`, `pre-reset-…`) are pruned to the newest
**5**; manual ones are never pruned. An empty database's snapshot is about 4 MB.

## Library

`src/lib.mts` (pure: paths, port derivation, lock classification, pruning),
`src/ports.mts` (bind probing), `src/wire.mts` (a dependency-free simple-query
client, also runnable: `DATABASE_URL=… node tooling/localdb/src/wire.mts "select 1"`),
`src/localdb.mts` (the operations; `runningUrl(root, db)` is what `pnpm seed` uses).

Upstream-owned: changed in the ai-sdlc starter, pulled with `pnpm sdlc:update`.

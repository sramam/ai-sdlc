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

A `localdb` block in the project's `sdlc.config.json` — added to the existing
file, not a file of its own: the loader validates the whole config, so a file
holding only `localdb` is refused (`branches: required`, `dirs: required` …).

```json
{
  "…": "the rest of sdlc.config.json",
  "localdb": {
    "databases": [
      {
        "name": "app",
        "migrate": "pnpm --filter @app/db exec drizzle-kit migrate"
      }
    ]
  }
}
```

`migrate` is the project's command, run from the repository root with
`DATABASE_URL` set to the database's URL. The ORM is the project's choice, so
applying migrations is the project's command. `env` (optional) names further
variables that also get the URL, for a migrate command that reads a different
name; most need none.

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

## Many connections, one backend

PGlite is a single Postgres session, and the extended query protocol keeps
per-session state (the unnamed statement and portal) as does a transaction. So
`src/socket.mts` gives the backend to **one connection at a time, for a whole
exchange**: from its first message until the ReadyForQuery that answers its
`Sync` (or its simple `Query`), and for as long as that ReadyForQuery says it is
inside a transaction. Others queue, first come first served. A pool of any size
works; nothing has to be told to open one connection.

The cost: work is serial — which PGlite already was — and **a transaction held
open blocks every other connection** until it commits or rolls back. Fine on a
laptop; a client that sits idle in a transaction stalls the rest. A connection
that drops mid-exchange or mid-transaction is synced and rolled back for it.

Still shared between connections, because there is only one session: named
prepared statements, `SET`, temp tables, `LISTEN`. A driver that prepares by
name (postgres.js by default) should have it turned off.

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
`src/ports.mts` (bind probing), `src/socket.mts` (the wire-protocol server and its session lock), `src/wire.mts` (a dependency-free simple-query
client, also runnable: `DATABASE_URL=… node tooling/localdb/src/wire.mts "select 1"`),
`src/localdb.mts` (the operations; `runningUrl(root, db)` is what `pnpm seed` uses).

Upstream-owned: changed in the ai-sdlc starter, pulled with `pnpm sdlc:update`.

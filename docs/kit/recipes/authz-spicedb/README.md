# Recipe: `authz-spicedb`

`@scope/authz` over SpiceDB, with the same interface as `authz-oso`:
`authorize(caller, action, resource)` (CheckPermission) and
`listFilter(caller, action, resourceType)` (LookupResources). Relationships
reach SpiceDB through an outbox written in the same Postgres transaction as
the rows they describe. Choose it over `authz-oso` for fine-grained sharing,
nested groups, deep hierarchies or several services sharing one authorization
source ([security.md](../../security.md) § _Authorization_).

| file                                  | is                                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `schema.zed`                          | the schema; permission names are `project_read` (SpiceDB names allow no dots)                             |
| `access-model.example.md`             | the same tiny access model as `authz-oso`                                                                 |
| `src/authz.ts`, `matrix.ts`           | the shared interface and the matrix generator (identical to `authz-oso`'s)                                |
| `src/spicedb.ts`                      | `spicedbAuthz(config)` over the HTTP gateway with `fetch`; `PERMISSIONS` maps each action to a permission |
| `src/outbox.ts`                       | the `authz_outbox` table (Drizzle), `enqueue(tx, ops)` and `relay(db, config)`                            |
| `src/spicedb.matrix.test.ts`          | the matrix (world loaded through the outbox), the outbox's behaviour, default deny, could-not-ask         |
| `src/could-not-run.ts`, `test-ci.mts` | the `AUTHZ-COULD-NOT-RUN` sentinel and the wrapper that maps it to exit 2 (§ _Run the tests_)             |

## The outbox

```ts
await db.transaction(async (tx) => {
  await tx.insert(project).values(row);
  await enqueue(tx, projectRelationships(row)); // same transaction: both or neither
});
const r = await relay(db, spicedb); // from a Queue consumer or a Cron Trigger
// r.zedToken: pass as `atLeastAsFresh` where a read must see this write at once
```

`relay` takes pending rows `for update skip locked`, sends them as one
`WriteRelationships` (atomic in SpiceDB), and marks them relayed with the
ZedToken. `OPERATION_TOUCH` and `OPERATION_DELETE` are idempotent, so a relay
that dies after SpiceDB accepted the write sends it again harmlessly. On
failure the rows stay pending with `attempts` and `last_error`.

## Run the tests

```bash
spicedb serve-testing --http-enabled --http-addr 127.0.0.1:8443
# or: docker run --rm -p 8443:8443 authzed/spicedb:v1.56.2 serve-testing --http-enabled
SPICEDB_URL=http://127.0.0.1:8443 pnpm test:ci   # 0 pass, 1 fail, 2 could not run
```

`serve-testing` gives every bearer token its own empty in-memory datastore,
so each suite takes a fresh random token, writes `schema.zed`, and is isolated
from every other.

**Could not run is never a pass.** Without SpiceDB the matrix fails with a
test titled `AUTHZ-COULD-NOT-RUN: …` (so plain `pnpm test` exits 1), and the
engine-free cases (catalogue, default deny, an unreachable engine is
`UNAVAILABLE`) still run. `pnpm test:ci` (`test-ci.mts`) runs the same suite and
exits 2 when those sentinels are the only failures, 1 on any other failure
(including a file that fails to load), 0 when everything passed. The project's
ci step declares 2 as _could not run_:

```json
{
  "name": "authz",
  "run": "pnpm --filter @app/authz run test:ci",
  "applies": "always",
  "unknownExitCodes": [2]
}
```

`AUTHZ_ENGINE=skip` is the one deliberate opt-out: the matrix is skipped, a
banner of `!` says no authorization cell was verified, and the run exits 0.
Never set it in CI.

Verified 2026-10-16 with the `spicedb` v1.56.2 darwin-arm64 release binary
(checksum matched the release's `checksums.txt`): 36 tests pass. Proved by
tripping: `project_delete = parent->is_member` fails the three member ×
`project.delete` cells. Re-run 2026-10-16 through `pnpm recipes:check` against
the container above (`docker.io/authzed/spicedb:v1.56.2` under podman): 36
pass, the same trip fails 3, and with SpiceDB down `test:ci` exits 2 (1
sentinel failed, 4 engine-free cases passed).

## What SpiceDB provides (docs read 2026-10-16)

- **`serve-testing`**: "An in-memory spicedb server which serves completely
  isolated datastores per client-supplied auth token used." gRPC `:50051`
  (read-only `:50052`), HTTP `:8443` with `--http-enabled` (read-only HTTP
  `:8444` with `--readonly-http-enabled`), `--load-configs` for YAML fixtures
  ([SpiceDB commands](https://authzed.com/docs/spicedb/concepts/commands)).
  `spicedb serve-testing --help` (v1.56.2) shows `--http-enabled` with no
  default, and the server logs `starting REST gateway` when it is set.
- **Images**: `authzed/spicedb` (mirrors `ghcr.io/authzed/spicedb`,
  `quay.io/authzed/spicedb`); "Production deployments should never use the
  `latest` tag" ([Install with Docker](https://authzed.com/docs/spicedb/getting-started/install/docker)).
- **The HTTP API** is listed as available on open source, Cloud, Dedicated and
  Enterprise ([HTTP API](https://authzed.com/docs/spicedb/api/http-api)); the
  page's reference body did not render for the fetcher, so the shapes below are
  observed against v1.56.2:

  | endpoint                         | body                                                            | answer                                                                     |
  | -------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
  | `POST /v1/schema/write`          | `{ schema }`                                                    | `{ writtenAt: { token } }`                                                 |
  | `POST /v1/relationships/write`   | `{ updates: [{ operation: "OPERATION_TOUCH", relationship }] }` | `{ writtenAt: { token } }`                                                 |
  | `POST /v1/permissions/check`     | `{ consistency, resource, permission, subject: { object } }`    | `{ permissionship: "PERMISSIONSHIP_HAS_PERMISSION" \| "…_NO_PERMISSION" }` |
  | `POST /v1/permissions/resources` | `{ consistency, resourceObjectType, permission, subject }`      | newline-delimited `{ "result": { resourceObjectId, permissionship } }`     |

  An unknown definition or permission answers a gRPC-style error
  (`code: 9`, `ERROR_REASON_UNKNOWN_DEFINITION`) with a non-2xx status.

## Why HTTP, not the Node client

`@authzed/authzed-node` 1.6.1 depends on `@grpc/grpc-js`, and a Worker cannot
open an HTTP/2 gRPC channel. The HTTP gateway serves the same v1 API as JSON
over `fetch`, which runs on workerd and in Node. Reaching a deployed SpiceDB or
AuthZed's hosted offering from a Worker was not tested (no account), nor
was HTTP gateway latency compared with gRPC.

## Rules

- **Default deny for the vocabulary**: an action or type not in `PERMISSIONS`
  is `FORBIDDEN` before SpiceDB is asked. A test keeps it equal to the access
  model's rows.
- **Could not ask is a refusal** (`UNAVAILABLE`): a network error, a timeout
  (2 s), a non-2xx (including a schema that was never loaded), a stream error,
  or a caveated (`CONDITIONAL`) answer. Only `HAS_PERMISSION` allows.
- **Consistency defaults to `fullyConsistent`**: correct first. Where latency
  matters, pass `atLeastAsFresh` with the ZedToken the relay stored after the
  write the read depends on.
- **Write relationships only through the outbox.** A relationship written
  without its row, or a row without its relationship, is a silent hole.
- **Agents** get an intersection: check the agent's declared scope before
  calling `authorize` with the activating person's caller ([ai.md](../../ai.md)).

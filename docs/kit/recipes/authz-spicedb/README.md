# Recipe: `authz-spicedb`

`@scope/authz` over **SpiceDB**, with the same interface as `authz-oso`:
`authorize(caller, action, resource)` (CheckPermission) and
`listFilter(caller, action, resourceType)` (LookupResources). Relationships
reach SpiceDB through an **outbox** written in the same Postgres transaction as
the rows they describe. Choose it over `authz-oso` for fine-grained sharing,
nested groups, deep hierarchies or several services sharing one authorization
source ([security.md](../../security.md) § _Authorization_).

| file                         | is                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `schema.zed`                 | the schema; permission names are `project_read` (SpiceDB names allow no dots)                             |
| `access-model.example.md`    | the same tiny access model as `authz-oso`                                                                 |
| `src/authz.ts`, `matrix.ts`  | the shared interface and the matrix generator (identical to `authz-oso`'s)                                |
| `src/spicedb.ts`             | `spicedbAuthz(config)` over the HTTP gateway with `fetch`; `PERMISSIONS` maps each action to a permission |
| `src/outbox.ts`              | the `authz_outbox` table (Drizzle), `enqueue(tx, ops)` and `relay(db, config)`                            |
| `src/spicedb.matrix.test.ts` | the matrix (world loaded **through the outbox**), the outbox's behaviour, default deny, could-not-ask     |

## The outbox

```ts
await db.transaction(async (tx) => {
  await tx.insert(project).values(row);
  await enqueue(tx, projectRelationships(row)); // same transaction: both or neither
});
const r = await relay(db, spicedb); // from a Queue consumer or a Cron Trigger
// r.zedToken: pass as `atLeastAsFresh` where a read must see this write at once
```

`relay` takes pending rows `for update skip locked`, sends them as **one**
`WriteRelationships` (atomic in SpiceDB), and marks them relayed with the
ZedToken. `OPERATION_TOUCH` and `OPERATION_DELETE` are idempotent, so a relay
that dies after SpiceDB accepted the write sends it again harmlessly. On
failure the rows stay pending with `attempts` and `last_error`.

## Run the tests

```bash
spicedb serve-testing --http-enabled --http-addr 127.0.0.1:8443
# or: docker run --rm -p 8443:8443 authzed/spicedb:v1.56.2 serve-testing --http-enabled
SPICEDB_URL=http://127.0.0.1:8443 pnpm test
```

`serve-testing` gives every bearer token its **own empty in-memory datastore**,
so each suite takes a fresh random token, writes `schema.zed`, and is isolated
from every other. Without SpiceDB, every case is **skipped with the reason**
(`COULD NOT RUN: no SpiceDB HTTP gateway at …`), never passed.

Verified 2026-10-16 with the `spicedb` v1.56.2 darwin-arm64 release binary
(checksum matched the release's `checksums.txt`): 36 tests pass. **Proved by
tripping**: `project_delete = parent->is_member` fails the three member ×
`project.delete` cells. The container command above was **not** run (the
binary was used).

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
  **observed** against v1.56.2:

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
AuthZed's hosted offering from a Worker was **not** tested (no account), nor
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

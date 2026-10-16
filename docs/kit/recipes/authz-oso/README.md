# Recipe: `authz-oso`

`@scope/authz` over **Oso Cloud**: `authorize(caller, action, resource)` and
`listFilter(caller, action, resourceType)`, a Polar policy with its own tests, a
matrix test generated from the access model, and the Oso Dev Server for local
runs. Choose it over `authz-spicedb` when the access model is roles within
tenants plus attribute rules ([security.md](../../security.md) § _Authorization_).

| file                      | is                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `policy.polar`            | the policy, with a Polar `test` block; the Dev Server and Oso Cloud run it on load and refuse a failing policy    |
| `data-bindings.yaml`      | **local authorization**: each fact in the policy, as a `SELECT` over our own tables                               |
| `access-model.example.md` | a tiny access model; the matrix test reads its `capability × persona` table                                       |
| `src/authz.ts`            | the shared interface (`Authz`, `Decision`, `ListFilter`), and `checkVocabulary` for default deny                  |
| `src/oso.ts`              | `osoAuthz(config)`: Oso's HTTP API over `fetch`, local or centralized facts; `CATALOGUE` of every action          |
| `src/matrix.ts`           | parses the access model and generates a check case per cell and a list case per row (shared with `authz-spicedb`) |
| `src/oso.matrix.test.ts`  | the matrix, in both fact modes, plus default deny, could-not-ask, a failing Polar test, and SQL quoting           |

## Local authorization, so there are no dual writes

Oso can evaluate facts that live in **our** Postgres: the app sends the policy
query and `data-bindings.yaml`, Oso returns SQL, the app runs it. Nothing is
written to Oso, so the "no dual writes" rule ([security.md](../../security.md))
is met by construction: a role is a `membership` row, a creator is a `project`
column. Centralized facts (written to Oso) also work and are tested; they need
the outbox that `authz-spicedb` shows.

| call                                | returns                                                       | used for     |
| ----------------------------------- | ------------------------------------------------------------- | ------------ |
| `POST /api/authorize_query` (local) | `{ sql }`: `SELECT EXISTS (…) as allowed`, run against our DB | `authorize`  |
| `POST /api/list_query` (local)      | `{ sql }`: a `WHERE` fragment over the column we name         | `listFilter` |
| `POST /api/authorize`, `/api/list`  | `{ allowed }`, `{ results }` (centralized facts)              | both         |

The `sql` filter is applied **in the query** by the `api` recipe's
`whereAllowed`; never fetch everything and filter in memory.

**What `authorize` answers and what it does not.** The policy decides per the
resource's own organization, so a person who is admin in `b` and member in `a`
gets `b`'s rights on `b`'s rows. The **active** relationship's tenant is the
scoped client's job (the `api` recipe). Both checks, always.

## Run the tests

```bash
docker run --rm -p 8080:8080 public.ecr.aws/osohq/dev-server:latest   # or podman
OSO_URL=http://127.0.0.1:8080 pnpm test
```

Each suite creates its own **test environment** on the Dev Server
(`POST /test_environment?copy=false`, which returns a token), loads
`policy.polar` into it, and loads the example world into a PGlite database.
Without a Dev Server every case is **skipped with the reason**
(`COULD NOT RUN: no Oso Dev Server at …`), never passed.

Verified 2026-10-16: `public.ecr.aws/osohq/dev-server:latest` (created
2026-08-05, digest `sha256:62885278…3ace`) under podman 5.5.2; 65 tests pass, in
both fact modes. **Proved by tripping**: letting `member` delete fails the three
matrix cells for member × `project.delete` in each mode, and a Polar `test`
asserting the wrong thing makes the policy load fail with `400 TestsFailed`.

## What Oso provides (docs read 2026-10-16)

- **Dev Server**: image `public.ecr.aws/osohq/dev-server:latest`, or a native
  binary from the dashboard; port 8080; test token
  `e_0123456789_12345_osotesttoken01xiIn`; `GET /api/healthcheck`;
  `POST /test_environment` (`copy=true|false`) for per-test isolation; state
  under `.oso/` (`OSO_DIRECTORY`). "Designed for development and testing only."
  ([Oso Dev Server](https://www.osohq.com/docs/develop/local-dev/oso-dev-server))
  The image starts with no policy; this recipe posts it (`POST /api/policy`)
  rather than mounting a file, because a podman machine on macOS cannot see
  `/tmp`.
- **Polar tests**: `test "…" { setup { … } assert …; assert_not …; }`
  ([Polar Tests](https://www.osohq.com/docs/reference/polar/tests.md)). Observed:
  posting a policy whose tests fail returns `400 {"error_type":"TestsFailed"}`
  and keeps the old policy.
- **Local authorization** supports PostgreSQL and MySQL, configured by a YAML
  of fact signatures to `SELECT`s, and does not support every rule shape
  (for example recursion mixing local and centralized facts)
  ([Local Authorization](https://www.osohq.com/docs/develop/facts/local-authorization.md)).
- **List filtering**: centralized `list` is suggested up to ~10,000 resources
  per user, local filtering beyond; every variable in a rule used by `list`
  must be constrained to facts
  ([List filtering](https://www.osohq.com/docs/develop/enforce/list-filtering.md)).
- **`list_query` body**: `{ query: { actor_type, actor_id, action,
resource_type, context_facts }, column, data_bindings }`
  ([Post list query](https://www.osohq.com/docs/reference/api/local-check-api/post-list_query.md)).
  The documented examples apply the returned SQL with `sql.raw`.

## Why not the SDK

`oso-cloud` 2.6.0 (npm) is CommonJS and requires `fs`, `http`, `https` and
`dns/promises`; it reads `dataBindings` from a **file path**, which a Worker
does not have. So `oso.ts` speaks the documented HTTP API with `fetch`, sending
the bindings as a string, which runs on workerd and in Node alike. The request
shapes were taken from the SDK's own source (`dist/src/api.js`) and checked
against the Dev Server. Calling Oso Cloud from a deployed Worker was **not**
tested (no account).

## Rules

- **Default deny for the vocabulary.** `CATALOGUE` names every action per
  resource type; anything else is `FORBIDDEN` before Oso is asked. A test keeps
  the catalogue equal to the access model's rows.
- **Could not ask is a refusal** (`UNAVAILABLE`): a network error, a timeout
  (2 s default), a non-2xx, or a failure running Oso's SQL.
- **The policy is code**: reviewed, with Polar tests beside the rules they pin,
  and the matrix test generated from `access-model.md`. A change that alters a
  cell fails until the access model changes with it.
- **Oso inlines ids into its SQL**, quoting them (observed: `'x'' or ''1''=''1'`);
  the suite trips it. Treat the SQL as Oso's, never edit or concatenate it.
- **Agents** get an intersection: check the agent's declared scope before
  calling `authorize` with the activating person's caller ([ai.md](../../ai.md)).

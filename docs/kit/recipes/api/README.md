# Recipe: `api`

The port skeleton (`packages/api`): a `Caller` a binding resolves, refusals
returned rather than thrown, a capability helper that validates, scopes,
authorizes and then runs against the **scoped** client, and a manifest entry
shape every binding renders from. One example entity (`project`) with a
contract suite against Postgres in process (PGlite).

Framework- and runtime-free: no TanStack, React or `cloudflare:` import, so it
runs in Node under Vitest and on workerd unchanged ([tech-stack.md](../../tech-stack.md)
§ _The architecture shape_).

| file                                  | is                                                                                                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/caller.ts`                       | `Caller` (user, tenant, role, party), **branded** so only `resolveCaller(session, activeRelationship)` can make one; a party-scoped role with no party throws `CALLER-001` |
| `src/refusal.ts`                      | `Refusal = { ok: false, code, detail, field? }`; codes `INVALID`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `UNAVAILABLE`                                                      |
| `src/scoped-db.ts`                    | `scopedDb(db, tenantId)`: every read and write on a tenant table conjoined with `tenant_id`; `whereAllowed(idColumn, filter)` puts the policy's list filter in the query   |
| `src/capability.ts`                   | `capability({ name, summary, effect, input, output, access, run })` and `invoke(cap, deps, caller, raw)`                                                                   |
| `src/manifest.ts`, `manifest.test.ts` | the list every binding renders (`as const`, so the SDK is typed from it), and `exclusions`; unique names, JSON-Schema-describable schemas, no authority key in any input   |
| `src/authz.ts`                        | the `@scope/authz` interface (identical in `authz-oso` and `authz-spicedb`)                                                                                                |
| `src/scripted-authz.ts`               | for the port's own suite: an `Authz` whose answers the test states (the policy matrix lives in the authz recipes)                                                          |
| `src/example/*`                       | `project.create`, `project.list`, `project.rename`, and the contract suite                                                                                                 |

## What `invoke` does, always, in this order

1. **Validate** with the capability's own Zod schema. A failure is `INVALID`
   with `field` set to the path, so a form puts it on the input (the `ui`
   recipe's form does). Inputs are `strictObject`, so `{ tenantId: … }` in a
   body is refused **by name**, never ignored.
2. **Scope**, for a capability on one row (`access.exists`): is it in the
   caller's tenant? If not, `NOT_FOUND`, and the engine is never asked, so a
   cross-tenant id cannot even learn what the policy would say.
3. **Authorize** through `@scope/authz`: `check` for one resource, `list` for a
   filter that `run` puts in its query. `FORBIDDEN` and `UNAVAILABLE` (could
   not ask) both refuse.
4. **Run** against the scoped client. Outputs are identifiers and the facts
   that changed (`{ ok: true, id }`), never rows; they are declared, and the
   contract suite parses results against them rather than parsing at runtime.

`deps.around` is where the binding passes the telemetry recipe's `inSpan`, so
every capability call is one span without the port importing a runtime.

## A binding, in TanStack Start

```ts
export const createProjectFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => raw) // the port validates; the binding only transports
  .handler(async ({ data }) => {
    const session = await auth.api.getSession({ headers: getRequestHeaders() });
    if (!session) return refuse("FORBIDDEN", "Sign in first.");
    const caller = resolveCaller({ userId: session.user.id }, await activeRelationship(session));
    if ("ok" in caller) return caller; // a Refusal: no active relationship, so the chooser comes first
    return withDb(env.HYPERDRIVE, (db) =>
      invoke(
        projectCreate,
        { db, authz, around: (n, f) => inSpan(workersTracer, n, { "app.capability": n }, f) },
        caller,
        data,
      ),
    );
  });
```

A sketch, not compiled here: how the request's headers are read in a server
function differs between TanStack Start versions (check the installed one, the
lesson of `app-tanstack-workers`' `.validator` trap). `activeRelationship`
reads the session's active relationship from the database; which tables hold it
comes from `access-model.md`.

## Run the tests

```bash
pnpm install && pnpm test        # 22 tests; PGlite in process, no network
```

Verified 2026-10-16 in a scratch project (Node 24.18.0, drizzle-orm 0.45.4,
@electric-sql/pglite 0.5.10, zod 4.6.7, vitest 3.2.4): all pass, `tsc --noEmit`
clean. **Proved by tripping**: removing the tenant conjunction from
`scopedDb` fails the cross-tenant rename and the list test.

## Rules

- **The scoped client is the only client a capability gets.** Drizzle has no
  client extension (Prisma's scoping hook), so scoping is a wrapper; a table
  without a `tenantId` column does not type-check as an argument.
- **`whereAllowed` applies Oso's SQL with `sql.raw`.** That SQL comes from the
  policy engine, not from a request, and Oso quotes the literals it inlines
  (`authz-oso` trips it with an id containing a quote). Nothing else in the port
  may use `sql.raw`.
- **The input schema is the form's resolver too**, so it must not import the
  database package (a client bundle would pull `pg` in).
- **Contract tests use real Postgres.** The DDL in the test stands in for the
  project's drizzle-kit migrations; in a project, `createTestDb` (db recipe, to
  come) applies them.

## Not here

The session-to-relationship resolver (it depends on the access model's
tables), XState machines, `createTestDb`, and the retention map. The HTTP API,
OpenAPI, MCP and SDK bindings over the manifest are
[`api-bindings`](../api-bindings/).

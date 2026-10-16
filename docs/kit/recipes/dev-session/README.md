# Recipe: `dev-session`

`pnpm dev:session [email]` signs a **seeded** account in to a running app,
locally or on `dev`, and writes a cookie jar for curl and a `storageState` for
Playwright, so a script or an agent can reach an authenticated page
([skills.md](../../skills.md) § _Tools that worked_). It completes the **real**
passwordless sign-in of the `app-tanstack-workers` recipe: request a code over
HTTP, read it back through Better Auth's server-only API, sign in over HTTP.

```bash
pnpm dev:session admin@example.test
curl -b .dev-session/admin@example.test.cookies.txt http://127.0.0.1:8787/api/auth/get-session
```

| file                      | instantiate as                       | is                                                                                         |
| ------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `dev-session.mts`         | `scripts/dev-session.mts`            | the CLI: environment verdict, database, Better Auth for reading the code, files out        |
| `src/dev-session.ts`      | `scripts/dev-session/dev-session.ts` | `envVerdict`, `devSignIn`, `curlJar`, `storageState`; runtime-free, dependencies passed in |
| `src/dev-session.test.ts` | beside it                            | the whole flow against an in-process Better Auth over PGlite                               |

Add `"dev:session": "node scripts/dev-session.mts"` to the root `package.json`,
and `.dev-session/` to `.gitignore` (the files are live sessions, written `0600`).

## What it refuses

| refusal              | when                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `DEVSESSION-001`     | `APP_ENV` is not set: a session minter must know where it points                                |
| `DEVSESSION-002`     | `APP_ENV` is anything but `local` or `dev` (an allow-list: `staging`, `production`, a typo)     |
| `DEVSESSION-003`     | `APP_ENV=local` but the URL is not this machine                                                 |
| `DEVSESSION-004`     | the address has no account: it signs in, it never signs up (OTP sign-in would create one)       |
| `DEVSESSION-005…008` | the app is unreachable, no code is outstanding, sign-in is refused, no session cookie came back |
| `DEVSESSION-009/010` | `BETTER_AUTH_SECRET` or `DATABASE_URL` missing, or the database unreachable                     |

## Why this is not a back door

The code is read with `auth.api.getVerificationOTP`, which Better Auth marks
**server-only**: over HTTP it is a 404 (the suite checks). Reaching it needs
`BETTER_AUTH_SECRET` (the codes are stored encrypted) and the database, which is
what the developer's `.dev.vars` already holds; it grants nothing those do not.
Every gate still applies: the account must exist, the code expires, and the
session is an ordinary, revocable one.

The script builds its own Better Auth instance only to read the code back. It
**must match the app's `createAuth` on `secret` and `storeOTP`**, or it decrypts
nothing.

## Verified

2026-10-16, better-auth 1.7.10, `@better-auth/drizzle-adapter` 1.7.10,
drizzle-orm 0.45.4, PGlite 0.5.10:

- `pnpm test`: 11 pass. The sign-in runs through `auth.handler` (the same
  handler the Worker mounts) against PGlite with the `db-drizzle` recipe's
  generated auth tables, and the resulting cookie returns the session.
- **The CLI end to end**, in a scratch layout: a stand-in app (Better Auth
  served by Node `http`, its PGlite exposed through `@electric-sql/pglite-socket`)
  and `node scripts/dev-session.mts seeded@example.test` → signed in;
  `curl -b <jar> …/api/auth/get-session` returned the session; an unknown
  address → `DEVSESSION-004`; `APP_ENV=production` → `DEVSESSION-002`;
  `APP_ENV=local` with a remote URL → `DEVSESSION-003`.
- **Not run against the Worker** (`wrangler dev`) or a deployed `dev`. The HTTP
  calls are the same ones the spike ran against the Worker
  ([../../spike-2026-10.md](../../spike-2026-10.md) § 6).

## Traps

- **Better Auth 1.7 disables its origin check under a test runner**
  (`skipOriginCheck` defaults to `isTest()` in `create-context`), so a suite
  asserting `INVALID_ORIGIN` passes for the wrong reason unless the instance sets
  `advanced: { disableOriginCheck: false }`. The suite sets it.
- **Observed with the check on** (1.7.10): a foreign `Origin` is
  `403 INVALID_ORIGIN`; a missing one is `403 MISSING_OR_NULL_ORIGIN` when the
  request carries cookies, and **allowed** when it carries none. The client
  always sends the app's own origin, which is honest: the check stops a page on
  another site, and this runs beside the secret. (door_nexa met
  `MISSING_OR_NULL_ORIGIN` on a cookie-less Node `fetch` with an earlier
  version; do not rely on either behaviour.)
- **Take the cookie from the response**, never build it from the body's token:
  it is `<token>.<signature>`.

## Not here

Choosing the active relationship after sign-in. A session with none reaches no
shell page (the chooser is a precondition, [ux.md](../../ux.md)); a project
whose people hold several relationships adds `--tenant <name>` and calls its
own switch capability, refusing when the choice is ambiguous rather than
guessing.

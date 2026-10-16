@ai-sdlc/seed: `pnpm seed` runs each declared app's seeder with SEED_SIZE/SEED_RANDOM/SEED_TODAY, a DATABASE_URL and capture transports forced; `@ai-sdlc/seed/helpers` is the deterministic PRNG, dates and ids. See README.md.

- **Targets are an allow-list** (local, dev, staging). Never add production to
  it, and never infer a target from a URL — a seed deletes and recreates rows.
- **One `createRandom(<concern>)` per concern.** A single shared stream means
  adding one draw early shifts every value after it, and every screenshot moves.
- **Dates come from `days(n)`, never a literal**, and never from `new Date()`
  inside a seeder — `SEED_TODAY` is what makes a run reproducible.
- **Real-shaped values come from captured lists via `fromCaptured`**, not from
  the PRNG: a random ZIP on a real state is data the product itself rejects.
- **`stableId` is the idempotency key.** Upsert on it, or delete rows where
  `isSeedId(id)` and recreate. The pinned values in `helpers.test.ts` change only
  on purpose — changing them moves every seeded id.
- The capture variables are forced on, but an app only honours them if its own
  transports read them; `EMAIL_TRANSPORT=capture` does nothing to an app that
  sends regardless.

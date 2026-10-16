// What only the HTTP binding does: status codes, credentials, scope, CSRF
// posture, limits. The answers themselves are bindings.contract.test.ts's.
import { describe, expect, it } from "vitest";
import { scriptedAuthz } from "../../../api/src/scripted-authz";
import { authenticate } from "../auth/principal";
import { APP, BASE, http, newWorld, verifiers } from "../test-support";

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${APP}${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const alice = { authorization: "Bearer key-alice" };

describe("status codes", () => {
  it.each([
    [{ name: "Roof" }, 200, undefined],
    [{ name: "R" }, 422, "INVALID"],
    [{ name: "Roof", tenantId: "org-b" }, 422, "INVALID"],
  ])("%j → %i", async (body, status, code) => {
    const res = await http(await newWorld())(post("/project/create", body, alice));
    expect(res.status).toBe(status);
    expect(res.headers.get("cache-control")).toBe("no-store");
    if (code) expect(await res.json()).toMatchObject({ ok: false, code });
  });

  it("a body that is not JSON is 400 INVALID with no field", async () => {
    const res = await http(await newWorld())(post("/project/create", "{nope", alice));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      code: "INVALID",
      detail: "The body is not valid JSON.",
    });
  });

  it("FORBIDDEN 403, NOT_FOUND 404, CONFLICT 409, UNAVAILABLE 503", async () => {
    const w = await newWorld();
    const h = http(w);
    const { id } = await (await h(post("/project/create", { name: "Roof" }, alice))).json();
    expect((await h(post("/project/create", { name: "Roof" }, alice))).status).toBe(409);
    const bruno = { authorization: "Bearer key-bruno" };
    expect((await h(post("/project/rename", { id, name: "Mine" }, bruno))).status).toBe(404);
    Object.assign(
      w.authz,
      scriptedAuthz({ authorize: { ok: false, code: "FORBIDDEN", detail: "" } }),
    );
    expect((await h(post("/project/create", { name: "B" + "x" }, alice))).status).toBe(403);
    Object.assign(
      w.authz,
      scriptedAuthz({ authorize: { ok: false, code: "UNAVAILABLE", detail: "down" } }),
    );
    expect((await h(post("/project/create", { name: "Bx" }, alice))).status).toBe(503);
  });

  it("an unknown capability is 404; a GET is 405; a form post is 415", async () => {
    const h = http(await newWorld());
    expect((await h(post("/project/delete", {}, alice))).status).toBe(404);
    const get = await h(new Request(`${APP}${BASE}/project/list`, { headers: alice }));
    expect([get.status, get.headers.get("allow")]).toEqual([405, "POST"]);
    const form = await h(
      new Request(`${APP}${BASE}/project/create`, {
        method: "POST",
        headers: { ...alice, "content-type": "application/x-www-form-urlencoded" },
        body: "name=Roof",
      }),
    );
    expect(form.status).toBe(415);
  });

  it("a defect is 500 with nothing about it in the body, and is reported", async () => {
    const errors: unknown[] = [];
    const h = http(await newWorld(), {
      deps: () => {
        throw new Error("secret connection string");
      },
      onError: (e) => errors.push(e),
    });
    const res = await h(post("/project/create", { name: "Roof" }, alice));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret");
    expect(errors).toHaveLength(1);
  });
});

describe("credentials", () => {
  it("no credential, or an unknown key, is 401 with a Bearer challenge", async () => {
    const h = http(await newWorld());
    const cases: Record<string, string>[] = [
      {},
      { authorization: "Bearer nope" },
      { authorization: "Basic eA==" },
    ];
    for (const headers of cases) {
      const res = await h(post("/project/list", {}, headers));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    }
  });

  it("a key whose relationship is no longer the user's is 403, not the other tenant", async () => {
    const res = await http(await newWorld())(
      post("/project/create", { name: "Roof" }, { authorization: "Bearer key-revoked" }),
    );
    expect(res.status).toBe(403);
  });

  it("a read-only key reads and cannot write, though its user may", async () => {
    const w = await newWorld();
    Object.assign(w.authz, scriptedAuthz({ listFilter: { ok: true, kind: "sql", where: "true" } }));
    const h = http(w);
    const ro = { authorization: "Bearer key-alice-ro" };
    expect((await h(post("/project/list", {}, ro))).status).toBe(200);
    w.authz.asked.length = 0;
    const write = await h(post("/project/create", { name: "Roof" }, ro));
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(w.authz.asked).toEqual([]); // refused before the port was reached
  });

  it("a key store that cannot be asked is 503, not 401", async () => {
    const h = http(await newWorld(), {
      authenticate: (r) => authenticate(r, verifiers({ apiKey: async () => "unavailable" })),
    });
    expect((await h(post("/project/list", {}, alice))).status).toBe(503);
  });

  it("a session cookie counts only from the app's own origin", async () => {
    let asked = 0;
    const v = verifiers({
      session: async () => (asked++, { userId: "u-alice" }),
      activeRelationship: async () => ({ tenantId: "org-a", role: "admin", party: null }),
    });
    const w = await newWorld();
    const h = http(w, { authenticate: (r) => authenticate(r, v) });
    const cookie = { cookie: "__Secure-better-auth.session_token=s" };
    expect(
      (await h(post("/project/create", { name: "Roof" }, { ...cookie, origin: APP }))).status,
    ).toBe(200);
    expect(
      (
        await h(
          post("/project/create", { name: "Evil" }, { ...cookie, origin: "https://evil.test" }),
        )
      ).status,
    ).toBe(401);
    expect((await h(post("/project/create", { name: "Evil" }, cookie))).status).toBe(401); // no Origin, no Sec-Fetch-Site
    expect(asked).toBe(1);
  });

  it("a bearer header wins over a cookie: a bad key never falls back to the session", async () => {
    const v = verifiers({ session: async () => ({ userId: "u-alice" }) });
    const h = http(await newWorld(), { authenticate: (r) => authenticate(r, v) });
    const res = await h(
      post("/project/list", {}, { origin: APP, cookie: "s=1", authorization: "Bearer nope" }),
    );
    expect(res.status).toBe(401);
  });
});

describe("limits", () => {
  it("the rate limit is keyed on the credential, and refuses with 429", async () => {
    const seen: string[] = [];
    const h = http(await newWorld(), { limit: async (k) => (seen.push(k), seen.length < 2) });
    expect((await h(post("/project/create", { name: "Roof" }, alice))).status).toBe(200);
    const res = await h(post("/project/create", { name: "Walls" }, alice));
    expect([res.status, res.headers.get("retry-after")]).toEqual([429, "60"]);
    expect(seen).toEqual(["key:1", "key:1"]);
  });

  it("a body over the limit is 413", async () => {
    const h = http(await newWorld(), { maxBodyBytes: 32 });
    expect((await h(post("/project/create", { name: "x".repeat(64) }, alice))).status).toBe(413);
  });
});

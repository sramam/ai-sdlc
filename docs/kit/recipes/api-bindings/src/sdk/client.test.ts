// The SDK's types come from the manifest's type, so these checks run in
// `tsc --noEmit` (the @ts-expect-error lines fail the typecheck if the type
// ever loosens) as well as in vitest.
import { describe, expect, expectTypeOf, it } from "vitest";
import type { exclusions, manifest } from "../../../api/src/manifest";
import type { Refusal } from "../../../api/src/refusal";
import { createClient, type Sdk } from "./client";

type Api = Sdk<typeof manifest, typeof exclusions>;

describe("types", () => {
  it("one method per capability, typed from its schemas", () => {
    expectTypeOf<keyof Api>().toEqualTypeOf<"project">();
    expectTypeOf<keyof Api["project"]>().toEqualTypeOf<"create" | "list" | "rename">();
    expectTypeOf<Parameters<Api["project"]["create"]>[0]>().toEqualTypeOf<{ name: string }>();
    expectTypeOf<Awaited<ReturnType<Api["project"]["create"]>>>().toEqualTypeOf<
      { ok: true; id: string } | Refusal
    >();
  });

  it("an exclusion removes the method", () => {
    type Without = Sdk<typeof manifest, { "project.rename": { sdk: "reason given here please" } }>;
    expectTypeOf<keyof Without["project"]>().toEqualTypeOf<"create" | "list">();
  });

  it("wrong input does not compile", () => {
    const api = createClient<typeof manifest>({
      baseUrl: "/api",
      fetch: async () => Response.json({ ok: true }),
    });
    // @ts-expect-error: name is required
    void api.project.create({});
    // @ts-expect-error: no such capability
    void api.project.delete({ id: "x" });
  });
});

describe("runtime", () => {
  const client = (res: Response) =>
    createClient<typeof manifest>({ baseUrl: "https://app.test/api", fetch: async () => res });

  it("returns a refusal; throws on a defect or a body that is not ours", async () => {
    const refusal = { ok: false, code: "CONFLICT", detail: "Exists.", field: "name" };
    expect(
      await client(Response.json(refusal, { status: 409 })).project.create({ name: "Roof" }),
    ).toEqual(refusal);
    await expect(
      client(Response.json({ ok: false, code: "INTERNAL" }, { status: 500 })).project.create({
        name: "Roof",
      }),
    ).rejects.toThrow(/SDK-002/);
    await expect(
      client(new Response("<html>", { status: 502 })).project.create({ name: "Roof" }),
    ).rejects.toThrow(/SDK-001/);
  });

  it("is not a thenable, so awaiting the client is harmless", async () => {
    const api = client(Response.json({ ok: true }));
    expect((api as unknown as { then?: unknown }).then).toBeUndefined();
  });
});

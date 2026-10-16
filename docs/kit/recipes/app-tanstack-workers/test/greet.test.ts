import { expect, it } from "vitest";
import { greet } from "../src/port/greet";

it("returns a refusal rather than throwing, with the field it belongs to", () => {
  expect(greet({ userId: null, role: "anonymous" }, { name: "nobody" })).toMatchObject({
    ok: false,
    code: "INVALID",
    field: "name",
  });
  expect(greet({ userId: null, role: "anonymous" }, { name: "Ada" })).toMatchObject({ ok: true });
});

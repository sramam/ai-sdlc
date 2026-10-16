import { describe, expect, it } from "vitest";
import { parseCapture, withPassword } from "./stack.mts";

describe("withPassword", () => {
  it("adds the password Hyperdrive's local mode requires, keeping the rest", () => {
    expect(withPassword("postgresql://postgres@127.0.0.1:55267/postgres?sslmode=disable")).toBe(
      "postgresql://postgres:localdb@127.0.0.1:55267/postgres?sslmode=disable",
    );
  });
  it("leaves an existing password alone", () => {
    expect(withPassword("postgresql://u:p@h:1/d")).toBe("postgresql://u:p@h:1/d");
  });
});

describe("parseCapture", () => {
  it("reads a capture line through wrangler's decoration", () => {
    const line =
      '\x1b[33m▲ [WARNING]\x1b[0m EMAIL-CAPTURE {"to":["a@example.test"],"subject":"Code","text":"1","html":"<b>1</b>"}\x1b[0m';
    expect(parseCapture(line)).toEqual({
      to: ["a@example.test"],
      subject: "Code",
      text: "1",
      html: "<b>1</b>",
    });
  });
  it("ignores any other line", () => expect(parseCapture("[wrangler:info] Ready")).toBeNull());
});

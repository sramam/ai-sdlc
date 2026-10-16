import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendCaptured,
  attachment,
  lastCaptured,
  outbox,
  outboxDir,
  outboxTo,
} from "./outbox.mts";

describe("the capture contract", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "journeys-outbox-")));

  it("reads an absent index as an empty outbox", () => {
    expect(outbox(join(dir, "nowhere"))).toEqual([]);
  });

  it("round-trips a message, its renderings and its attachment", () => {
    appendCaptured(dir, {
      to: ["a@example.test"],
      subject: "Your code",
      html: "<p>1</p>",
      text: "1",
    });
    appendCaptured(dir, {
      to: ["a@example.test"],
      subject: "Your statement",
      html: "<p>s</p>",
      text: "s",
      attachments: [{ filename: "sep.pdf", bytes: new Uint8Array([1, 2, 3]) }],
    });
    expect(outbox(dir)).toHaveLength(2);
    expect(outboxTo("b@example.test", dir)).toEqual([]);
    const message = lastCaptured("a@example.test", /statement/, dir);
    expect([...attachment(message, /\.pdf$/)]).toEqual([1, 2, 3]);
  });

  it("refuses rather than returning nothing, and says what was there", () => {
    expect(() => lastCaptured("a@example.test", /invoice/, dir)).toThrow(
      /"Your code", "Your statement"/,
    );
    const message = lastCaptured("a@example.test", /code/, dir);
    expect(() => attachment(message, "x.pdf")).toThrow(/it had none/);
  });

  it("names the variable when no stack set one", () => {
    expect(() => outboxDir({})).toThrow(/JOURNEY_OUTBOX_DIR/);
  });
});

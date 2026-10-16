import type { Page } from "@playwright/test";
import { describe, expect, it } from "vitest";
import type { EvaluatingPage } from "../mask/dom.mts";

const asEvaluating = (page: Page): EvaluatingPage => page;

describe("a Playwright Page", () => {
  it("is an EvaluatingPage", () => {
    expect(typeof asEvaluating).toBe("function");
  });
});

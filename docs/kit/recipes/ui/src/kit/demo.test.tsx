import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Demo } from "./demo";

describe("demo", () => {
  it("renders every pattern inside the shell without a runtime error", () => {
    render(<Demo />);
    expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
  });
});

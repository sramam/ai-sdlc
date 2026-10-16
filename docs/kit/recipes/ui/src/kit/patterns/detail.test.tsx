import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";
import { DetailView } from "./detail";

describe("detail", () => {
  it("a header with status and actions, and sections as tabs", async () => {
    render(
      <DetailView
        title="Roof replacement"
        status={{ label: "Draft", tone: "secondary" }}
        actions={<Button>Submit</Button>}
        sections={[
          { id: "overview", label: "Overview", content: <p>Overview body</p> },
          { id: "history", label: "History", content: <p>History body</p> },
        ]}
      />,
    );
    expect(screen.getByRole("heading", { name: "Roof replacement" })).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("Overview body")).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(screen.getByText("History body")).toBeVisible();
    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ProjectForm, type Refusal } from "./form";

describe("form", () => {
  it("validates on blur with the capability's schema, on the field", async () => {
    render(<ProjectForm submit={async () => ({ ok: true })} />);
    const name = screen.getByLabelText("Name");
    await userEvent.type(name, "R");
    await userEvent.tab();
    expect(await screen.findByText("At least 2 characters.")).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-invalid", "true");
  });

  it("a server refusal with a field lands on that field, and focuses it", async () => {
    const refusal: Refusal = {
      ok: false,
      code: "CONFLICT",
      detail: "A project with that name exists.",
      field: "name",
    };
    render(<ProjectForm submit={async () => refusal} />);
    await userEvent.type(screen.getByLabelText("Name"), "Roof");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByText(refusal.detail)).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Name")).toHaveFocus();
    expect(screen.queryByRole("alert")?.textContent ?? "").not.toContain("Roof");
  });

  it("a refusal with no field is shown once, above the button", async () => {
    render(
      <ProjectForm
        submit={async () => ({ ok: false, code: "FORBIDDEN", detail: "You may not do that." })}
      />,
    );
    await userEvent.type(screen.getByLabelText("Name"), "Roof");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByText("You may not do that.")).toBeInTheDocument();
  });

  it("the button is disabled while submitting", async () => {
    let release!: () => void;
    render(<ProjectForm submit={() => new Promise((r) => (release = () => r({ ok: true })))} />);
    await userEvent.type(screen.getByLabelText("Name"), "Roof");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
    release();
    expect(await screen.findByRole("button", { name: "Create project" })).toBeEnabled();
  });
});

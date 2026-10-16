import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PageHeader } from "./page-header";
import { AppShell } from "./app-shell";
import type { Relationship } from "./relationships";

const rels: Relationship[] = [
  { id: "r1", tenantName: "Acme", role: "Admin", shell: "customer", lastUsedAt: "2026-10-01" },
  { id: "r2", tenantName: "Birch", role: "Member", shell: "customer", lastUsedAt: "2026-10-15" },
  { id: "r3", tenantName: "Acme", role: "Support", shell: "backoffice", lastUsedAt: "2026-09-01" },
];

function setup(activeId = "r1") {
  const onSwitch = vi.fn();
  const onNavigate = vi.fn();
  render(
    <AppShell
      product="Example"
      nav={[
        {
          label: "Work",
          items: [
            { label: "Projects", href: "/projects" },
            { label: "Reports", href: "/reports" },
          ],
        },
      ]}
      currentHref="/projects"
      user={{ name: "Ada", email: "ada@example.test" }}
      relationships={rels}
      activeId={activeId}
      onSwitch={onSwitch}
      onNavigate={onNavigate}
      onSignOut={() => {}}
    >
      <PageHeader
        title="Projects"
        description="Everything in flight."
        trail={[{ label: "Home", href: "/" }]}
      />
    </AppShell>,
  );
  return { onSwitch, onNavigate };
}

describe("shell", () => {
  it("shows the active role in the frame, and the nav it reaches", () => {
    setup();
    expect(screen.getByTestId("active-role")).toHaveTextContent("Admin · Acme");
    // The sidebar link is the current page (the breadcrumb's last item is role=link too, without an href).
    const nav = screen
      .getAllByRole("link", { name: "Projects" })
      .filter((a) => a.hasAttribute("href"));
    expect(nav).toHaveLength(1);
    expect(nav[0]).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument();
  });

  it("the role switcher lists relationships most recent first, and switching calls the server", async () => {
    const { onSwitch } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Account and role" }));
    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual([
      "Member · Birch",
      "Admin · Acme",
      "Support · Acme",
    ]);
    expect(items[1]).toHaveAttribute("aria-checked", "true");
    await userEvent.click(items[0]!);
    expect(onSwitch).toHaveBeenCalledWith(rels[1]);
  });

  it("⌘K opens the palette; it navigates and switches", async () => {
    const { onNavigate } = setup();
    await userEvent.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByPlaceholderText("Go to, or switch…");
    await userEvent.type(input, "Reports");
    await userEvent.keyboard("{Enter}");
    expect(onNavigate).toHaveBeenCalledWith("/reports");
  });

  it("a backoffice relationship gets a visibly different frame", () => {
    setup("r3");
    expect(screen.getByRole("status")).toHaveTextContent("Backoffice: Acme");
  });
});

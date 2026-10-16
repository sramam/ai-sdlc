import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KpiTiles } from "./dashboard";

describe("dashboard", () => {
  it("a tile shows a compact number, the exact value on hover, and links to its list", () => {
    render(
      <KpiTiles
        kpis={[
          {
            label: "Collected this month",
            value: 24_231_800,
            kind: "cents",
            href: "/payments?month=current",
          },
          { label: "Open tickets", value: 1_284, kind: "count", href: "/tickets?status=open" },
        ]}
      />,
    );
    const money = screen.getByText("$242.3K");
    expect(money).toHaveAttribute("title", "$242,318.00");
    expect(money.closest("a")).toHaveAttribute("href", "/payments?month=current");
    expect(screen.getByText("1.3K")).toHaveAttribute("title", "1,284");
  });
});

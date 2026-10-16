// The reference page: every pattern inside the shell, with sample data. Not a
// product screen; it is what `vite build` compiles so the built CSS can be checked.
import { FolderIcon, GaugeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "./shell/app-shell";
import { PageHeader } from "./shell/page-header";
import type { Relationship } from "./shell/relationships";
import { KpiTiles } from "./patterns/dashboard";
import { DataState } from "./patterns/data-state";
import { DetailView } from "./patterns/detail";
import { EmptyState } from "./patterns/empty";
import { ProjectForm } from "./patterns/form";
import { browserSearch, DataTable, useListState } from "./patterns/list";

const relationships: Relationship[] = [
  { id: "r1", tenantName: "Acme", role: "Admin", shell: "customer", lastUsedAt: "2026-10-15" },
  { id: "r2", tenantName: "Birch", role: "Member", shell: "customer", lastUsedAt: "2026-10-01" },
];
const projects = [
  { id: "p1", name: "Roof", budgetCents: 1_250_000 },
  { id: "p2", name: "Lobby", budgetCents: 90_000 },
];

export function Demo() {
  const list = useListState(browserSearch);
  return (
    <TooltipProvider>
      <AppShell
        product="Example"
        nav={[
          {
            label: "Work",
            items: [
              { label: "Dashboard", href: "/", icon: <GaugeIcon /> },
              { label: "Projects", href: "/projects", icon: <FolderIcon /> },
            ],
          },
        ]}
        currentHref="/projects"
        user={{ name: "Ada", email: "ada@example.test" }}
        relationships={relationships}
        activeId="r1"
        onSwitch={() => {}}
        onNavigate={(href) => window.location.assign(href)}
        onSignOut={() => {}}
      >
        <PageHeader
          title="Projects"
          description="Everything in flight."
          action={<Button>New project</Button>}
        />
        <KpiTiles
          kpis={[{ label: "Budget", value: 134_000_000, kind: "cents", href: "/projects" }]}
        />
        <DataState
          state={{ status: "ready", data: projects }}
          skeleton={<Skeleton className="h-40 w-full" />}
          isEmpty={(d) => d.length === 0}
          empty={
            <EmptyState
              title="No projects yet"
              why="Projects you create appear here."
              action={<Button>New project</Button>}
            />
          }
        >
          {(rows) => (
            <DataTable
              rows={rows}
              rowId={(p) => p.id}
              list={list}
              empty={<p className="text-sm text-muted-foreground">Nothing matches.</p>}
              columns={[
                {
                  id: "name",
                  header: "Name",
                  value: (p) => p.name,
                  cell: (p) => <a href={`/projects/${p.id}`}>{p.name}</a>,
                  searchable: true,
                },
                {
                  id: "budget",
                  header: "Budget",
                  value: (p) => p.budgetCents,
                  cell: (p) =>
                    `$${(p.budgetCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
                },
              ]}
            />
          )}
        </DataState>
        <DetailView
          title="Roof"
          status={{ label: "Draft", tone: "secondary" }}
          sections={[
            {
              id: "o",
              label: "Overview",
              content: <ProjectForm submit={async () => ({ ok: true })} />,
            },
          ]}
        />
      </AppShell>
      <Toaster />
    </TooltipProvider>
  );
}

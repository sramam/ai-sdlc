// The shell for one persona group: a collapsible sidebar showing only what the
// role reaches, a top bar with ⌘K and the user menu (which holds the role
// switcher), and one content column. A backoffice shell is a different frame
// (`shell="backoffice"` changes the band), never this one with extra items.
import type { ReactNode } from "react";
import { SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { CommandPalette, useCommandShortcut, type Destination } from "./command-palette";
import type { Relationship } from "./relationships";
import { UserMenu } from "./role-switcher";

export type NavSection = { label: string; items: (Destination & { icon?: ReactNode })[] };

export function AppShell(props: {
  product: string;
  nav: NavSection[];
  currentHref: string;
  user: { name: string; email: string };
  relationships: Relationship[];
  activeId: string;
  onSwitch: (r: Relationship) => void;
  onNavigate: (href: string) => void;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useCommandShortcut();
  const active = props.relationships.find((r) => r.id === props.activeId);
  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <span className="truncate px-2 font-semibold">{props.product}</span>
        </SidebarHeader>
        <SidebarContent>
          {props.nav.map((section) => (
            <SidebarGroup key={section.label}>
              <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
              <SidebarMenu>
                {section.items.map((item) => (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      isActive={item.href === props.currentHref}
                      tooltip={item.label}
                      // isActive styles it; aria-current tells a screen reader
                      render={
                        <a
                          href={item.href}
                          aria-current={item.href === props.currentHref ? "page" : undefined}
                        />
                      }
                    >
                      {item.icon}
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        {active?.shell === "backoffice" ? (
          <div role="status" className="bg-destructive px-4 py-1 text-sm text-white">
            Backoffice: {active.tenantName}
          </div>
        ) : null}
        <header className="flex h-12 items-center gap-2 border-b px-3">
          <SidebarTrigger />
          <Button
            variant="outline"
            size="sm"
            className="text-muted-foreground"
            onClick={() => setOpen(true)}
          >
            <SearchIcon /> Search <Kbd>⌘K</Kbd>
          </Button>
          <div className="ml-auto">
            <UserMenu
              user={props.user}
              relationships={props.relationships}
              activeId={props.activeId}
              onSwitch={props.onSwitch}
              onSignOut={props.onSignOut}
            />
          </div>
        </header>
        <main className="flex flex-1 flex-col gap-6 p-6">{props.children}</main>
      </SidebarInset>
      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        destinations={props.nav.flatMap((s) => s.items)}
        relationships={props.relationships}
        activeId={props.activeId}
        onNavigate={props.onNavigate}
        onSwitch={props.onSwitch}
      />
    </SidebarProvider>
  );
}

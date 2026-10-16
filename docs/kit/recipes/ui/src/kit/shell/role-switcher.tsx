// The role switcher lives in the user menu, lists relationships most recent
// first, and marks the active one. Switching is the server's job (it changes
// the session's active relationship, then the shell and scope follow).
import { ChevronsUpDownIcon, LogOutIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { byRecent, type Relationship } from "./relationships";

export function UserMenu(props: {
  user: { name: string; email: string };
  relationships: Relationship[];
  activeId: string;
  onSwitch: (r: Relationship) => void;
  onSignOut: () => void;
}) {
  const active = props.relationships.find((r) => r.id === props.activeId);
  return (
    <DropdownMenu>
      {/* Base UI: the trigger renders the Button (`render`), not `asChild`. */}
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="sm" aria-label="Account and role" />}
      >
        <span className="font-medium">{props.user.name}</span>
        {active ? (
          <span className="text-muted-foreground" data-testid="active-role">
            {active.role} · {active.tenantName}
          </span>
        ) : null}
        <ChevronsUpDownIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Acting as</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={props.activeId}
            onValueChange={(id) => {
              const r = props.relationships.find((x) => x.id === id);
              if (r && r.id !== props.activeId) props.onSwitch(r);
            }}
          >
            {byRecent(props.relationships).map((r) => (
              <DropdownMenuRadioItem key={r.id} value={r.id}>
                {r.role} · {r.tenantName}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={props.onSignOut}>
          <LogOutIcon /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Choosing is a precondition: with several relationships and none active, this is the page. */
export function RelationshipChooser(props: {
  relationships: Relationship[];
  onChoose: (r: Relationship) => void;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-2 p-6">
      <h1 className="text-xl font-semibold">Where are you working today?</h1>
      {byRecent(props.relationships).map((r) => (
        <Button
          key={r.id}
          variant="outline"
          className="justify-between"
          onClick={() => props.onChoose(r)}
        >
          <span>{r.tenantName}</span>
          <span className="text-muted-foreground">{r.role}</span>
        </Button>
      ))}
    </div>
  );
}

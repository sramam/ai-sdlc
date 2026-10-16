// ⌘K: every destination and every relationship switch, from the keyboard.
// Note: shadcn's Command is cmdk, which depends on @radix-ui/react-dialog even
// in the Base UI registry (README § Base UI coverage).
import { useEffect, useState } from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { byRecent, type Relationship } from "./relationships";

export type Destination = { label: string; href: string };

export function useCommandShortcut(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return [open, setOpen];
}

export function CommandPalette(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  destinations: Destination[];
  relationships: Relationship[];
  activeId: string;
  onNavigate: (href: string) => void;
  onSwitch: (r: Relationship) => void;
}) {
  const others = byRecent(props.relationships).filter((r) => r.id !== props.activeId);
  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      {/* The Base UI registry's CommandDialog does not wrap its children in <Command>. */}
      <Command>
        <CommandInput placeholder="Go to, or switch…" />
        <CommandList>
          <CommandEmpty>Nothing matches.</CommandEmpty>
          <CommandGroup heading="Go to">
            {props.destinations.map((d) => (
              <CommandItem
                key={d.href}
                onSelect={() => (props.onOpenChange(false), props.onNavigate(d.href))}
              >
                {d.label}
              </CommandItem>
            ))}
          </CommandGroup>
          {others.length ? (
            <CommandGroup heading="Switch to">
              {others.map((r) => (
                <CommandItem
                  key={r.id}
                  onSelect={() => (props.onOpenChange(false), props.onSwitch(r))}
                >
                  {r.role} · {r.tenantName}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

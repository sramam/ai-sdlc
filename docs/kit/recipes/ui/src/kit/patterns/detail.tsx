// Detail: a header with a status badge and actions, then sections as tabs.
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function DetailView(props: {
  title: string;
  status: { label: string; tone: "default" | "secondary" | "destructive" | "outline" };
  actions?: ReactNode;
  sections: { id: string; label: string; content: ReactNode }[];
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{props.title}</h1>
        <Badge variant={props.status.tone}>{props.status.label}</Badge>
        <div className="ml-auto flex gap-2">{props.actions}</div>
      </div>
      <Tabs defaultValue={props.sections[0]?.id}>
        <TabsList>
          {props.sections.map((s) => (
            <TabsTrigger key={s.id} value={s.id}>
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {props.sections.map((s) => (
          <TabsContent key={s.id} value={s.id}>
            {s.content}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

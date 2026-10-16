// What this is, why it is empty, and the ONE action that fills it (ux.md).
import type { ReactNode } from "react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export function EmptyState(props: {
  icon?: ReactNode;
  title: string;
  why: string;
  action?: ReactNode;
}) {
  return (
    <Empty>
      <EmptyHeader>
        {props.icon ? <EmptyMedia variant="icon">{props.icon}</EmptyMedia> : null}
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.why}</EmptyDescription>
      </EmptyHeader>
      {props.action ? <EmptyContent>{props.action}</EmptyContent> : null}
    </Empty>
  );
}

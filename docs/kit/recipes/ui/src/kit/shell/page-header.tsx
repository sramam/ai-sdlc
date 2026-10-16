// One header per page: title, a one-line description, the ONE primary action
// (right-aligned), and breadcrumbs once the page is more than a level deep.
import { Fragment, type ReactNode } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export function PageHeader(props: {
  title: string;
  description?: string;
  action?: ReactNode;
  trail?: { label: string; href: string }[];
}) {
  return (
    <header className="flex flex-col gap-2">
      {props.trail?.length ? (
        <Breadcrumb>
          <BreadcrumbList>
            {props.trail.map((t) => (
              <Fragment key={t.href}>
                <BreadcrumbItem>
                  {/* Base UI composes with `render`, not Radix's `asChild` */}
                  <BreadcrumbLink render={<a href={t.href} />}>{t.label}</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
              </Fragment>
            ))}
            <BreadcrumbItem>
              <BreadcrumbPage>{props.title}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      ) : null}
      <div className="flex items-start gap-4">
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{props.title}</h1>
          {props.description ? (
            <p className="text-sm text-muted-foreground">{props.description}</p>
          ) : null}
        </div>
        {props.action}
      </div>
    </header>
  );
}

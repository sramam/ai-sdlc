// Every data view has four states, designed (ux.md): loading (skeletons shaped
// like the content), empty, error (what happened, and a retry), and populated.
// A view renders through this, so none of the four can be forgotten.
import type { ReactNode } from "react";
import { AlertCircleIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export type Loadable<T> =
  | { status: "loading" }
  | { status: "error"; message: string; retry?: () => void }
  | { status: "ready"; data: T };

export function DataState<T>(props: {
  state: Loadable<T>;
  /** Shaped like the content it stands in for, not a spinner. */
  skeleton: ReactNode;
  isEmpty: (data: T) => boolean;
  empty: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const { state } = props;
  if (state.status === "loading") {
    return (
      <div aria-busy="true" aria-live="polite">
        {props.skeleton}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <Alert variant="destructive">
        <AlertCircleIcon />
        <AlertTitle>Could not load this</AlertTitle>
        <AlertDescription>
          <p>{state.message}</p>
          {state.retry ? (
            <Button variant="outline" size="sm" onClick={state.retry}>
              Try again
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }
  return props.isEmpty(state.data) ? props.empty : props.children(state.data);
}

import { createFileRoute } from "@tanstack/react-router";
import { greetFn } from "../server/greet";

// An SSR route whose loader calls a server function.
export const Route = createFileRoute("/")({
  loader: () => greetFn({ data: { name: "Workers" } }),
  component: Home,
});

function Home() {
  const result = Route.useLoaderData();
  return <h1 data-testid="greeting">{result.ok ? result.greeting : result.detail}</h1>;
}

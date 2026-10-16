import { createFileRoute } from "@tanstack/react-router";
import { listNotesFn } from "../server/notes";

// Reads through Hyperdrive: the database round trip the spike proved.
export const Route = createFileRoute("/notes")({
  loader: () => listNotesFn(),
  component: Notes,
});

function Notes() {
  const result = Route.useLoaderData();
  return (
    <ul data-testid="notes">
      {result.notes.map((n) => (
        <li key={n.id}>{n.body}</li>
      ))}
    </ul>
  );
}

import { createFileRoute } from "@tanstack/react-router";

// The journeys adapter's readyPath. A deployed /api/health also checks the
// database branch (docs/kit/environments.md § Rules); this one only answers.
export const Route = createFileRoute("/health")({
  server: { handlers: { GET: async () => Response.json({ ok: true }) } },
});

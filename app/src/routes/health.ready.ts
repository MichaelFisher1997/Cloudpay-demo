import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/health/ready")({
  server: { handlers: { GET: () => Response.json({ status: "ready" }) } },
});

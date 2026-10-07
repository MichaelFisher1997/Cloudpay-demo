import { createFileRoute } from "@tanstack/react-router";
import { authSettings } from "../../../server/auth";

export const Route = createFileRoute("/api/auth/config")({
  server: {
    handlers: {
      GET: () =>
        Response.json(
          { publishableKey: authSettings().publishableKey },
          { headers: { "Cache-Control": "no-store" } },
        ),
    },
  },
});

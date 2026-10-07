import { createFileRoute } from "@tanstack/react-router";
import { forbiddenMutation } from "../../../server/http";
const retired = () =>
  Response.json(
    { error: "Password sign-in is retired. Use Clerk Google sign-in." },
    { status: 410 },
  );
export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: retired,
      POST: async ({ request }) => {
        const denied = forbiddenMutation(request);
        if (denied) return denied;
        return retired();
      },
    },
  },
});

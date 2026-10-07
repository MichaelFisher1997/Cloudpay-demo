import { createFileRoute } from "@tanstack/react-router";
import { authInstance } from "../../../server/auth";
import { forbiddenMutation, failure } from "../../../server/http";
import { normalizeAlbClientIp } from "../../../server/alb-ip";
export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          return (await authInstance()).handler(normalizeAlbClientIp(request));
        } catch (error) {
          return failure(error);
        }
      },
      POST: async ({ request }) => {
        const denied = forbiddenMutation(request);
        if (denied) return denied;
        try {
          return (await authInstance()).handler(normalizeAlbClientIp(request));
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});

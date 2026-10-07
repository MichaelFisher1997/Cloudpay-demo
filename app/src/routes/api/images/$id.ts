import { createFileRoute } from "@tanstack/react-router";
import {
  owner,
  unauthorized,
  forbiddenMutation,
  failure,
} from "../../../server/http";
import { remove } from "../../../server/images";
export const Route = createFileRoute("/api/images/$id")({
  server: {
    handlers: {
      DELETE: async ({ request, params }) => {
        const denied = forbiddenMutation(request);
        if (denied) return denied;
        try {
          const user = await owner(request);
          if (!user) return unauthorized();
          return (await remove(params.id, user))
            ? new Response(null, { status: 204 })
            : Response.json({ error: "Not found" }, { status: 404 });
        } catch (e) {
          return failure(e);
        }
      },
    },
  },
});

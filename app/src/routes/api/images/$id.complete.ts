import { createFileRoute } from "@tanstack/react-router";
import {
  owner,
  unauthorized,
  forbiddenMutation,
  failure,
} from "../../../server/http";
import {
  complete,
  ConflictError,
  VerificationError,
} from "../../../server/images";
export const Route = createFileRoute("/api/images/$id/complete")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const denied = forbiddenMutation(request);
        if (denied) return denied;
        try {
          const user = await owner(request);
          if (!user) return unauthorized();
          const image = await complete(params.id, user);
          return image
            ? Response.json(image)
            : Response.json({ error: "Not found" }, { status: 404 });
        } catch (e) {
          if (e instanceof ConflictError)
            return Response.json(
              { error: "Finalization in progress" },
              { status: 409 },
            );
          if (e instanceof VerificationError)
            return Response.json(
              { error: "Upload verification failed" },
              { status: 422 },
            );
          return failure(e);
        }
      },
    },
  },
});

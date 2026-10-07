import { createFileRoute } from "@tanstack/react-router";
import {
  owner,
  unauthorized,
  forbiddenMutation,
  failure,
  smallJson,
  BadRequestError,
} from "../../../server/http";
import { initiate, list, InputError } from "../../../server/images";
export const Route = createFileRoute("/api/images/")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const user = await owner(request);
          return user
            ? Response.json({ images: await list(user) })
            : unauthorized();
        } catch (e) {
          return failure(e);
        }
      },
      POST: async ({ request }) => {
        const denied = forbiddenMutation(request);
        if (denied) return denied;
        try {
          const user = await owner(request);
          if (!user) return unauthorized();
          if (Number(request.headers.get("content-length")) > 2048)
            return Response.json({ error: "Invalid input" }, { status: 400 });
          const body = await smallJson(request);
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw new BadRequestError("Invalid input");
          }
          return Response.json(
            await initiate(user, body as Parameters<typeof initiate>[1]),
          );
        } catch (e) {
          if (e instanceof InputError || e instanceof BadRequestError) {
            return Response.json({ error: "Invalid upload" }, { status: 400 });
          }
          return failure(e);
        }
      },
    },
  },
});

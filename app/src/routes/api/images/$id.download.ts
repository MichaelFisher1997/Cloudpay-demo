import { createFileRoute } from "@tanstack/react-router";
import { owner, unauthorized, failure } from "../../../server/http";
import { download } from "../../../server/images";
export const Route = createFileRoute("/api/images/$id/download")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const user = await owner(request);
          if (!user) return unauthorized();
          const signed = await download(params.id, user);
          return signed
            ? Response.json(signed, {
                headers: { "Cache-Control": "no-store" },
              })
            : Response.json({ error: "Not found" }, { status: 404 });
        } catch (e) {
          return failure(e);
        }
      },
    },
  },
});

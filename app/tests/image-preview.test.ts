import { expect, test } from "bun:test";
import { requestImagePreview } from "../src/components/image-preview";

test("preview uses the authenticated ownership-checked download endpoint", async () => {
  const signal = new AbortController().signal;
  const url = "https://images.example/photo.png?signature=fixture";
  const result = await requestImagePreview(
    "image/id",
    "fixture-token",
    signal,
    async (path, options) => {
      expect(path).toBe("/api/images/image%2Fid/download");
      expect(new Headers(options.headers).get("Authorization")).toBe(
        "Bearer fixture-token",
      );
      expect(options.credentials).toBe("omit");
      expect(options.cache).toBe("no-store");
      expect(options.signal).toBe(signal);
      return Response.json({ url });
    },
  );
  expect(result).toBe(url);
});

test("preview never requests a signed URL without a session token", async () => {
  let requested = false;
  await expect(
    requestImagePreview(
      "image",
      null,
      new AbortController().signal,
      async () => {
        requested = true;
        return Response.json({});
      },
    ),
  ).rejects.toThrow("Please sign in again.");
  expect(requested).toBe(false);
});

test("preview rejects denied, missing and failed downloads", async () => {
  for (const status of [401, 403, 404, 500]) {
    await expect(
      requestImagePreview(
        "image",
        "fixture-token",
        new AbortController().signal,
        async () => new Response(null, { status }),
      ),
    ).rejects.toThrow("Preview unavailable");
  }
});

test("preview rejects invalid or insecure image URLs", async () => {
  for (const result of [
    null,
    {},
    { url: 123 },
    { url: "http://images.example/photo.png" },
    { url: "javascript:alert(1)" },
  ]) {
    await expect(
      requestImagePreview(
        "image",
        "fixture-token",
        new AbortController().signal,
        async () => Response.json(result),
      ),
    ).rejects.toThrow("Preview unavailable");
  }
});

test("preview cleanup cancels requests before fetching", async () => {
  const abort = new AbortController();
  abort.abort();
  let requested = false;
  await expect(
    requestImagePreview("image", "fixture-token", abort.signal, async () => {
      requested = true;
      return Response.json({});
    }),
  ).rejects.toThrow();
  expect(requested).toBe(false);
});

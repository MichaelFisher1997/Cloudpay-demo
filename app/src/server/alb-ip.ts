import { isIP } from "node:net";

/**
 * ALB append mode puts the observed client IP at the right end of XFF.
 * Only safe when task ingress is limited to the ALB security group.
 */
export function normalizeAlbClientIp(request: Request): Request {
  const headers = new Headers(request.headers);
  const forwarded = headers.get("x-forwarded-for");
  const observed = forwarded?.split(",").at(-1)?.trim();
  if (observed && isIP(observed)) headers.set("x-forwarded-for", observed);
  else headers.delete("x-forwarded-for");
  // Bun's Request(existing, { headers }) merges deleted headers back in.
  // Reconstruct from URL/body so an invalid XFF genuinely disappears.
  const init: RequestInit & { duplex: "half" } = {
    method: request.method,
    headers,
    body: request.body,
    signal: request.signal,
    duplex: "half",
  };
  return new Request(request.url, init);
}

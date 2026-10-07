import { authInstance } from "./auth";
import { config, sameOrigin } from "./config";
export async function owner(req: Request): Promise<string | null> {
  const auth = await authInstance();
  const session = await auth.api.getSession({ headers: req.headers });
  return session?.user.id ?? null;
}
export function forbiddenMutation(req: Request): Response | null {
  return sameOrigin(req, config().origin)
    ? null
    : Response.json({ error: "Forbidden origin" }, { status: 403 });
}
export function failure(_error: unknown): Response {
  console.error("Request failed");
  return Response.json({ error: "Request failed" }, { status: 500 });
}
export class BadRequestError extends Error {}
export function unauthorized(): Response {
  return Response.json({ error: "Authentication required" }, { status: 401 });
}

export async function smallJson(req: Request, max = 2048): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) throw new BadRequestError("Missing body");
  let total = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new BadRequestError("Body too large");
    }
    chunks.push(value);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new BadRequestError("Invalid JSON");
  }
}

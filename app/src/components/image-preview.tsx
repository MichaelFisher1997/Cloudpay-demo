import { useAuth } from "@clerk/react";
import { useEffect, useState } from "react";

type PreviewRequest = (path: string, options: RequestInit) => Promise<Response>;

export async function requestImagePreview(
  imageId: string,
  token: string | null,
  signal: AbortSignal,
  request: PreviewRequest = fetch,
): Promise<string> {
  signal.throwIfAborted();
  if (!token) throw new Error("Please sign in again.");
  // Reuse the ownership-checked endpoint; never make the bucket public.
  const response = await request(
    `/api/images/${encodeURIComponent(imageId)}/download`,
    {
      headers: { Authorization: `Bearer ${token}` },
      credentials: "omit",
      cache: "no-store",
      signal,
    },
  );
  if (!response.ok) throw new Error("Preview unavailable");
  const result: unknown = await response.json();
  if (
    !result ||
    typeof result !== "object" ||
    !("url" in result) ||
    typeof result.url !== "string" ||
    new URL(result.url).protocol !== "https:"
  )
    throw new Error("Preview unavailable");
  return result.url;
}

export function ImagePreview({
  imageId,
  name,
}: {
  imageId: string;
  name: string;
}) {
  const { getToken, userId } = useAuth();
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    setUrl(undefined);
    setFailed(false);
    async function load() {
      try {
        const signedUrl = await requestImagePreview(
          imageId,
          await getToken(),
          abort.signal,
        );
        if (!abort.signal.aborted) setUrl(signedUrl);
      } catch {
        if (!abort.signal.aborted) setFailed(true);
      }
    }
    void load();
    return () => abort.abort();
  }, [imageId, userId, getToken, attempt]);

  if (failed)
    return (
      <div className="placeholder preview-status">
        <span>Preview unavailable</span>
        <button
          onClick={() => setAttempt((value) => value + 1)}
          aria-label={`Retry preview for ${name}`}
        >
          Retry preview
        </button>
      </div>
    );

  if (!url)
    return (
      <div className="placeholder preview-status" role="status">
        Loading preview…
      </div>
    );

  // Load immediately: lazy-loading could defer the GET past the URL's expiry.
  // The signed URL stays in memory only; do not log it or persist it.
  return (
    <img
      className="image-preview"
      src={url}
      alt={name}
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

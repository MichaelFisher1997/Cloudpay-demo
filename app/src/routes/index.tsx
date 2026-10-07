import { createFileRoute } from "@tanstack/react-router";
import { SignIn, SignUp, UserButton, useAuth, useUser } from "@clerk/react";
import { useEffect, useState } from "react";
import { Sha256 } from "@aws-crypto/sha256-js";
export const Route = createFileRoute("/")({ component: Gallery });
type Image = { id: string; name: string; status: string; created_at: string };
function Gallery() {
  const { user, isLoaded } = useUser();
  const { getToken } = useAuth();
  const [images, setImages] = useState<Image[]>([]);
  const [register, setRegister] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function api(path: string, options: RequestInit = {}) {
    const token = await getToken();
    if (!token) throw new Error("Please sign in again.");
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(path, { ...options, credentials: "omit", headers });
  }
  async function refresh(signal?: AbortSignal) {
    const response = await api("/api/images/", { signal });
    if (signal?.aborted) return;
    setAccessDenied(response.status === 401);
    if (!response.ok)
      throw new Error("This account does not have gallery access.");
    setImages((await response.json()).images ?? []);
  }
  useEffect(() => {
    const abort = new AbortController();
    setImages([]);
    setAccessDenied(false);
    setError("");
    if (user)
      void refresh(abort.signal).catch((error: unknown) => {
        if (!abort.signal.aborted)
          setError(
            error instanceof Error ? error.message : "Unable to connect",
          );
      });
    return () => abort.abort();
  }, [user?.id]);
  async function upload(file: File) {
    setBusy(true);
    setError("");
    try {
      if (
        file.size > 10 * 1024 * 1024 ||
        !["image/jpeg", "image/png", "image/webp"].includes(file.type)
      )
        throw Error("Choose a JPEG, PNG or WebP under 10 MiB.");
      // The deliberate HTTP ALB demo is not a browser secure context, so
      // crypto.subtle is unavailable there. This is a checksum, not encryption.
      const hash = new Sha256();
      hash.update(new Uint8Array(await file.arrayBuffer()));
      const digest = await hash.digest();
      const checksum = btoa(String.fromCharCode(...new Uint8Array(digest)));
      const init = await api("/api/images/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: file.name,
          contentType: file.type,
          size: file.size,
          checksum,
        }),
      });
      if (!init.ok) throw Error("Could not start upload");
      const { id, url, fields } = await init.json();
      const form = new FormData();
      for (const [key, value] of Object.entries(
        fields as Record<string, string>,
      ))
        form.append(key, value);
      form.append("file", file);
      if (!(await fetch(url, { method: "POST", body: form })).ok)
        throw Error("Storage rejected upload");
      if (!(await api(`/api/images/${id}/complete`, { method: "POST" })).ok)
        throw Error("Verification failed; try again");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function view(id: string) {
    const response = await api(`/api/images/${id}/download`);
    if (!response.ok) {
      setError("Download unavailable");
      return;
    }
    const { url } = await response.json();
    window.open(url, "_blank", "noopener,noreferrer");
  }
  async function remove(id: string) {
    if (!confirm("Delete this photo?")) return;
    const response = await api(`/api/images/${id}`, { method: "DELETE" });
    if (response.ok) await refresh();
    else setError("Could not delete photo");
  }
  return (
    <main className="shell">
      <header>
        <div className="brand">
          ✦ <strong>Godiffy</strong>
        </div>
        {user && (
          <div className="account">
            <span>{user.primaryEmailAddress?.emailAddress}</span>
            <UserButton />
          </div>
        )}
      </header>
      {!isLoaded ? (
        <section className="login" role="status">
          Loading sign-in…
        </section>
      ) : !user ? (
        <section className="login">
          <p className="eyebrow">YOUR PRIVATE SPACE</p>
          <h1>Photos, just for you.</h1>
          <p className="muted">
            Sign in with Google. Access is limited to approved email addresses.
          </p>
          <div className="clerk-signin">
            {register ? (
              <SignUp
                routing="hash"
                forceRedirectUrl="/"
                signInForceRedirectUrl="/"
              />
            ) : (
              <SignIn
                routing="hash"
                forceRedirectUrl="/"
                signUpForceRedirectUrl="/"
              />
            )}
          </div>
          <button className="link" onClick={() => setRegister(!register)}>
            {register
              ? "Already registered? Sign in"
              : "First visit? Create your approved account"}
          </button>
        </section>
      ) : accessDenied ? (
        <section className="login">
          <h1>This account isn’t on the demo allowlist.</h1>
          <p className="muted">
            Use an approved Google account, or ask the demo owner to add your
            email.
          </p>
        </section>
      ) : (
        <section className="gallery">
          <p className="eyebrow">YOUR GALLERY</p>
          <div className="heading">
            <div>
              <h1>A place for your photos.</h1>
              <p className="muted">
                Private to your account. JPEG, PNG or WebP, up to 10 MiB.
              </p>
            </div>
            <label className="upload">
              {busy ? "Working…" : "＋ Add photos"}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          {images.length ? (
            <div className="grid">
              {images.map((image) => (
                <article key={image.id}>
                  <div className="placeholder">✦</div>
                  <div className="details">
                    <div>
                      <strong>{image.name}</strong>
                      <small>
                        {image.status === "ready"
                          ? new Date(image.created_at).toLocaleDateString()
                          : image.status}
                      </small>
                    </div>
                    <div className="actions">
                      {image.status === "ready" ? (
                        <button onClick={() => void view(image.id)}>
                          Open
                        </button>
                      ) : (
                        <button
                          onClick={async () => {
                            setBusy(true);
                            try {
                              await api(`/api/images/${image.id}/complete`, {
                                method: "POST",
                              });
                              await refresh();
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          Retry
                        </button>
                      )}
                      <button onClick={() => void remove(image.id)}>
                        Delete
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty">
              <span>✦</span>
              <h2>Nothing here yet</h2>
              <p>Upload your first image to get started.</p>
            </div>
          )}
        </section>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </main>
  );
}

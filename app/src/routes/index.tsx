import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
export const Route = createFileRoute("/")({ component: Gallery });
type Image = { id: string; name: string; status: string; created_at: string };
function Gallery() {
  const [user, setUser] = useState<{ name: string; email: string } | null>(
    null,
  );
  const [images, setImages] = useState<Image[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [register, setRegister] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function refresh() {
    const session = await fetch("/api/auth/get-session").then((r) => r.json());
    setUser(session?.user ?? null);
    if (session?.user)
      setImages(
        (await fetch("/api/images/").then((r) => r.json())).images ?? [],
      );
  }
  useEffect(() => {
    void refresh().catch(() => setError("Unable to connect"));
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        register ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            register ? { email, password, name } : { email, password },
          ),
        },
      );
      if (!response.ok)
        throw Error("Could not sign in. Check your credentials or invitation.");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File) {
    setBusy(true);
    setError("");
    try {
      if (
        file.size > 10 * 1024 * 1024 ||
        !["image/jpeg", "image/png", "image/webp"].includes(file.type)
      )
        throw Error("Choose a JPEG, PNG or WebP under 10 MiB.");
      const digest = await crypto.subtle.digest(
        "SHA-256",
        await file.arrayBuffer(),
      );
      const checksum = btoa(String.fromCharCode(...new Uint8Array(digest)));
      const init = await fetch("/api/images/", {
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
      if (!(await fetch(`/api/images/${id}/complete`, { method: "POST" })).ok)
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
    const response = await fetch(`/api/images/${id}/download`);
    if (!response.ok) {
      setError("Download unavailable");
      return;
    }
    const { url } = await response.json();
    window.open(url, "_blank", "noopener,noreferrer");
  }
  async function remove(id: string) {
    if (!confirm("Delete this photo?")) return;
    const response = await fetch(`/api/images/${id}`, { method: "DELETE" });
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
            <span>{user.email}</span>
            <button
              onClick={async () => {
                await fetch("/api/auth/sign-out", { method: "POST" });
                setImages([]);
                setUser(null);
              }}
            >
              Sign out
            </button>
          </div>
        )}
      </header>
      {!user ? (
        <section className="login">
          <p className="eyebrow">YOUR PRIVATE SPACE</p>
          <h1>Photos, just for you.</h1>
          <p className="muted">A quiet home for the images you want to keep.</p>
          <form onSubmit={submit}>
            {register && (
              <label>
                Name
                <input
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                />
              </label>
            )}
            <label>
              Email
              <input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </label>
            <label>
              Password
              <input
                required
                type="password"
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={register ? "new-password" : "current-password"}
              />
            </label>
            <button className="primary" disabled={busy}>
              {register ? "Create invited account" : "Sign in"}
            </button>
          </form>
          <button className="link" onClick={() => setRegister(!register)}>
            {register
              ? "Already registered? Sign in"
              : "Have an invitation? Register"}
          </button>
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
                              await fetch(`/api/images/${image.id}/complete`, {
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

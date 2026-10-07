import { ClerkProvider } from "@clerk/react";
import { useEffect, useState, type ReactNode } from "react";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [publishableKey, setPublishableKey] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    void fetch("/api/auth/config", { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Authentication unavailable");
        const value = (await response.json()) as { publishableKey?: unknown };
        if (typeof value.publishableKey !== "string")
          throw new Error("Invalid config");
        setPublishableKey(value.publishableKey);
      })
      .catch(() => {
        if (!abort.signal.aborted) setFailed(true);
      });
    return () => abort.abort();
  }, []);
  if (!publishableKey)
    return (
      <main className="shell">
        <section className="login" role={failed ? "alert" : "status"}>
          <p className="eyebrow">GODIFFY</p>
          <h1>
            {failed
              ? "Sign-in is unavailable."
              : "Opening your private gallery…"}
          </h1>
          {failed && <p>Please refresh to try again.</p>}
        </section>
      </main>
    );
  return (
    <ClerkProvider publishableKey={publishableKey} afterSignOutUrl="/">
      {children}
    </ClerkProvider>
  );
}

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
export default defineConfig({
  ssr: { external: ["pg"] },
  plugins: [tanstackStart(), nitro({ preset: "bun" }), react()],
});

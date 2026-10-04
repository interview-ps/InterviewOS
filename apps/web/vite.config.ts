import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const apiTarget = `http://127.0.0.1:${process.env.INTERVIEW_OS_PORT ?? "4100"}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 3000,
    strictPort: true,
    host: process.env.INTERVIEW_OS_HOST ?? "127.0.0.1",
    // no compression on the dev proxy — SSE streams through unbuffered
    proxy: { "/api": { target: apiTarget } },
  },
  preview: {
    port: 3000,
    strictPort: true,
    host: process.env.INTERVIEW_OS_HOST ?? "127.0.0.1",
    proxy: { "/api": { target: apiTarget } },
  },
});

import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const dir = path.dirname(fileURLToPath(import.meta.url));

/** Builds the sandboxed plugin-runtime bundle served at /api/ui/runtime/. */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    outDir: path.join(dir, "dist/runtime"),
    emptyOutDir: true,
    lib: {
      entry: path.join(dir, "src/runtime/index.ts"),
      formats: ["es"],
      fileName: () => "plugin-runtime.js",
      cssFileName: "plugin-runtime",
    },
  },
});

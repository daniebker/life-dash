import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

// Builds one self-contained dist/index.html (scripts and styles inlined), so the dashboard works
// from the server, from any static host, or opened straight from disk.
export default defineConfig({
  root,
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: fileURLToPath(new URL("../dist", import.meta.url)),
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    // `npm run dev`: the dashboard on :5173 talks to `npm start` on :8080
    proxy: { "/api": "http://127.0.0.1:8080" },
  },
});

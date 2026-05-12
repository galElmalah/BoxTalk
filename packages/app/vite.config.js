import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Electron loads dist/index.html via file://; relative base keeps asset URLs working.
export default defineConfig({
  root: path.resolve(__dirname, "src"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
    target: "chrome120",
  },
  server: {
    port: 5173,
  },
});

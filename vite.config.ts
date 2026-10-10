import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "client",
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@client": path.resolve(import.meta.dirname, "client/src"),
    },
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3000" },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/client"),
    emptyOutDir: true,
    // No public source maps in production builds.
    sourcemap: false,
    rollupOptions: {
      output: {
        // Long-lived vendor chunks cache across app deploys.
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          data: ["@tanstack/react-query", "@trpc/client", "@trpc/react-query", "superjson"],
          icons: ["lucide-react"],
        },
      },
    },
  },
});

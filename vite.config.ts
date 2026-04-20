import path from "path";
import fs from "fs";
import { optimizeGLTF } from "@iwsdk/vite-plugin-gltf-optimizer";
import { iwsdkDev } from "@iwsdk/vite-plugin-dev";
import { compileUIKit } from "@iwsdk/vite-plugin-uikitml";
import { defineConfig, type Plugin } from "vite";
import mkcert from "vite-plugin-mkcert";

// Detect server link mode: server writes .link-room on startup when -link flag is used
const linkRoomFile = path.resolve(__dirname, ".link-room");
const LINK_ROOM: string | null = fs.existsSync(linkRoomFile)
  ? fs.readFileSync(linkRoomFile, "utf-8").trim() || null
  : null;

const threePkg = path.resolve(__dirname, "node_modules/three");

/**
 * Redirect IWSDK's bundled super-three imports to the project's single
 * Three.js instance, preventing duplicate Three.js modules and the
 * resulting "Can not resolve #include <splatDefines>" shader error from SparkJS.
 */
function deduplicateThree(): Plugin {
  const bundledThreeRe =
    /node_modules\/@iwsdk\/core\/dist\/node_modules\/\.pnpm\/super-three@[\d.]+\/node_modules\/super-three\/(.*)/;

  return {
    name: "deduplicate-three",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer) return null;

      const resolved = source.startsWith(".")
        ? path.resolve(path.dirname(importer), source)
        : null;
      const target = resolved ?? source;
      const match = target.match(bundledThreeRe);
      if (match) {
        return path.join(threePkg, match[1]);
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [
    deduplicateThree(),
    mkcert(),
    iwsdkDev({
      emulator: {
        device: "metaQuest3",
        activation: "localhost",
      },
      // In link mode, skip the headless Playwright browser (reduces overhead)
      ...(LINK_ROOM ? {} : { ai: {} }),
      verbose: true,
    }),

    compileUIKit({ sourceDir: "ui", outputDir: "public/ui", verbose: true }),
    optimizeGLTF({
      level: "medium",
    }),
  ],
  resolve: {
    alias: {
      three: threePkg,
    },
    dedupe: ["three"],
  },
  server: {
    host: "0.0.0.0",
    port: 8081,
    open: LINK_ROOM ? `/?room=${LINK_ROOM}` : true,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
        changeOrigin: true
      },
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: "dist",
    sourcemap: process.env.NODE_ENV !== "production",
    target: "esnext",
    rollupOptions: { input: "./index.html" },
  },
  esbuild: { target: "esnext" },
  optimizeDeps: {
    exclude: ["@babylonjs/havok"],
    esbuildOptions: { target: "esnext" },
  },
  publicDir: "public",
  base: "./",
});

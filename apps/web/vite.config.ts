import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  server: { port: 3000 },
  ...(command === "build" ? { ssr: { noExternal: true } } : {}),
  plugins: [
    tanstackStart(),
    // node-server instead of Nitro's Bun preset: Bun.serve drops responses slower than its idle timeout,
    // and a FinTS sync waiting for a TAN can take minutes.
    nitro({
      preset: "node-server",
      plugins: ["./src/server/plugins/startup.ts", "./src/server/plugins/scheduler.ts"],
      compressPublicAssets: { gzip: true, brotli: true },
    }),
    viteReact(),
  ],
}));

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages}/*/src/**/*.test.ts"],
    globalSetup: ["apps/web/src/server/test-db.ts"],
    setupFiles: ["apps/web/src/server/test-env.ts"],
    fileParallelism: false,
  },
});

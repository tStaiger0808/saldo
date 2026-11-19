import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// E2E_PORT and E2E_DATABASE_URL give a second working copy its own server and database, so runs can go side by side.
const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE_ENABLE_BANKING = `http://127.0.0.1:${PORT + 1}`;
process.env.E2E_DATABASE_URL ??= "postgres://finanzen:finanzen-test@127.0.0.1:54329/saldo_e2e";
process.env.ENABLE_BANKING_API_URL ??= FAKE_ENABLE_BANKING;

export default defineConfig({
  testDir: "./e2e",
  // Outside the repository, so Biome does not lint the generated results.
  outputDir: join(tmpdir(), `saldo-e2e-results-${PORT}`),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 60_000,
  use: { baseURL: BASE, locale: "de-DE", timezoneId: "Europe/Berlin", reducedMotion: "reduce", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun --bun vite build && bun e2e/server.ts",
    url: `${BASE}/api/health`,
    timeout: 300_000,
    reuseExistingServer: false,
    stdout: "pipe",
    env: {
      DATABASE_URL: process.env.E2E_DATABASE_URL,
      APP_URL: BASE,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      AUTH_SECRET: "e2e-auth-secret-0123456789abcdef0123456789",
      ENCRYPTION_KEY: Buffer.from("e2e-key-0123456789abcdef01234567").toString("base64"),
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "e2e-password-123",
      SALDO_SCHEDULER: "off",
      SIGN_IN_LIMIT: "1000",
      PSU_IP_LOOKUP: "off",
      ENABLE_BANKING_API_URL: FAKE_ENABLE_BANKING,
      GIVVE_API_URL: `${FAKE_ENABLE_BANKING}/givve`,
      // e2e/server.ts empties it; the backup spec needs pg_dump, pg_restore and rclone on the PATH.
      BACKUP_DIR: join(tmpdir(), `saldo-e2e-backups-${PORT}`),
    },
  },
});

// Vitest setupFile: fixed dummy configuration for tests, never real secrets.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://finanzen:finanzen-test@127.0.0.1:54329/finanzen_test";
process.env.APP_URL = "https://saldo.test";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret-0000";
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.PSU_IP_LOOKUP = "off";
// Bun loads the developer's .env; a proxy setting from there must not change what the tests see.
process.env.TRUSTED_PROXY = "off";

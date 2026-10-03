function asHttpUrl(value: string): URL {
  return new URL(value.replace(/^postgres(ql)?:/i, "http:"));
}

export function databaseIdentity(url: string): string {
  const parsed = asHttpUrl(url);
  const db = parsed.pathname.replace(/^\//, "").split("/")[0];
  return `${parsed.hostname}:${parsed.port || "5432"}/${db}`;
}

export function resolveIsolatedTestDatabaseUrl(): string {
  const testUrl = process.env['TEST_DATABASE_URL']?.trim();
  if (!testUrl) {
    throw new Error("TEST_DATABASE_URL is required and must point at an isolated p0p1 test database");
  }
  const dbName = asHttpUrl(testUrl).pathname.replace(/^\//, "").split("/")[0];
  if (!/p0p1/i.test(dbName)) {
    throw new Error("TEST_DATABASE_URL database name must contain p0p1");
  }
  const liveUrl = process.env.DATABASE_URL?.trim();
  if (liveUrl && databaseIdentity(testUrl) === databaseIdentity(liveUrl)) {
    throw new Error("TEST_DATABASE_URL must not equal DATABASE_URL");
  }
  return testUrl;
}

export const SYNTHETIC_LOCAL_TEST_URL =
  "postgresql://postgres:p0p1_test_only@127.0.0.1:55432/nv_p0p1_test";

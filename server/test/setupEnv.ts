process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??=
  process.env.TEST_DATABASE_URL ?? "postgres://flowos:flowos@localhost:5432/flowos_test";
process.env.APP_ORIGIN ??= "http://localhost:5173";
process.env.STORAGE_DIR ??= `${process.env.TMPDIR ?? "/tmp"}/flowos-test-storage`;

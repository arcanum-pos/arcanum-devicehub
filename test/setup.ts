// Applies schema.sql (split into statements by vitest.config.mts) before
// each test file. Every statement is CREATE ... IF NOT EXISTS, so this is
// idempotent — and tests never rely on a clean database anyway: each one
// registers its own random terminal and org ids.
import { env } from 'cloudflare:test';
import { beforeAll } from 'vitest';

beforeAll(async () => {
  const statements = JSON.parse(env.TEST_SCHEMA) as string[];
  await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
});

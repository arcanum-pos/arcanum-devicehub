import { readFileSync } from 'node:fs';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// schema.sql split into single statements (D1 exec/prepare want one at a
// time) — read here, in Node, so any schema change flows straight into the
// tests. `--` comments are stripped first.
function sqlStatements(file: string): string[] {
  const sql = readFileSync(new URL(file, import.meta.url), 'utf8')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_SCHEMA: JSON.stringify(sqlStatements('./schema.sql')),
          // Test-only values — never real secrets.
          WS_TOKEN_SECRET: 'test-ws-secret',
          INTERNAL_API_KEY: 'test-internal-key',
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});

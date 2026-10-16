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

// schema.sql as text, as esbuild bundles it for the self-hosted server.
const sqlAsText = {
  name: 'sql-as-text',
  transform(code: string, id: string) {
    return id.endsWith('.sql') ? `export default ${JSON.stringify(code)};` : null;
  },
};

// Two projects (SELF_HOSTING.md): the Worker in the Workers runtime as on
// Cloudflare, and the self-hosted server (src/node.ts) on Node.
export default defineConfig({
  test: {
    projects: [
      {
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
        test: { name: 'cloudflare', include: ['test/*.test.ts'], setupFiles: ['./test/setup.ts'] },
      },
      {
        plugins: [sqlAsText],
        test: { name: 'node', environment: 'node', include: ['test/node/*.test.ts'] },
      },
    ],
  },
});

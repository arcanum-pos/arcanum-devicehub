import type { Env as WorkerEnv } from '../src/index';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      // schema.sql as a JSON array of statements — see vitest.config.mts.
      TEST_SCHEMA: string;
    }
  }
}

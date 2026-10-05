// Bindings and vars of the ghosttape Worker (see root wrangler.jsonc).
import type { TapeRelay } from './relay';

export interface Env {
  /** static assets from web/dist */
  ASSETS: Fetcher;
  /** the relay Durable Object (one instance, named "main") */
  TAPE: DurableObjectNamespace<TapeRelay>;
  /** per-IP limiter for /api/state and /api/tape (namespace 2001); optional so local tests survive without it */
  VIEW_LIMITER?: RateLimit;
  /** per-IP limiter for /api/ingest (namespace 2002) */
  INGEST_LIMITER?: RateLimit;
  /** HMAC key shared with the uplink. Production: `wrangler secret put DEVICE_SECRET`; local: .dev.vars */
  DEVICE_SECRET?: string;
  /** LOCAL TESTS ONLY (.dev.vars). If present on a non-local host every /api request is refused. */
  ALLOW_TEST_OVERRIDE?: string;
  /** LOCAL TESTS ONLY: JSON merged over limits.jsonc when ALLOW_TEST_OVERRIDE === "1" (e2e passes it with --var). */
  LIMITS_OVERRIDE?: string;
}

// limits.jsonc (repo root, owner-only) is bundled at build time as text via the wrangler "Text" rule.
// Changing it therefore needs a redeploy, which also restarts the Durable Object with the new values.
import limitsText from '../../limits.jsonc';
import { resolveLimits, type Limits, type OverrideEnv } from './limits';

export const LIMITS_TEXT: string = limitsText;

export const currentLimits = (env: OverrideEnv): Limits => resolveLimits(LIMITS_TEXT, env);

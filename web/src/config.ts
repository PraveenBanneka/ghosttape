// Loads the owner-only limits.jsonc from the repo root at build time (Praveen edits it by hand).
import limitsText from '../../limits.jsonc?raw';
import type { AccountConfig } from './model/account';

export interface Limits {
  online_enabled: boolean;
  max_stream_minutes_per_day: number;
  max_ingest_messages_per_day: number;
  max_do_gb_seconds_per_day: number;
  max_concurrent_viewers: number;
  firecrawl_calls_per_task: number;
  trading: AccountConfig;
}

/** Same comment stripping as tools/limits-lib.cjs (the file holds no strings containing "//"). */
export function parseJsonc(text: string): unknown {
  return JSON.parse(
    text.replace(/\r\n/g, '\n').replace(/^\s*\/\/.*$/gm, '').replace(/,?\s*\/\/[^\n"]*$/gm, m => (m.trim().startsWith(',') ? ',' : '')),
  );
}

export const LIMITS = parseJsonc(limitsText) as Limits;

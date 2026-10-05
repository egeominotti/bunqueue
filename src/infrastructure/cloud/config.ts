/**
 * bunqueue Cloud Configuration
 * Env-only entry point used by `CloudAgent.create` (the MCP server). Parsing and
 * validation live in `src/config/cloud.ts`, shared with the server, so the two
 * cannot drift: an invalid value throws an error naming the variable.
 */

import type { CloudConfig } from './types';
import { resolveCloudConfig } from '../../config/cloud';

/** Parse Cloud configuration from environment. Returns null if disabled. */
export function loadCloudConfig(dataPath?: string): CloudConfig | null {
  return resolveCloudConfig(null, dataPath);
}

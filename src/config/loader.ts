/**
 * bunqueue Config File Loader
 * Auto-discovers and loads bunqueue.config.{ts,js,mjs}
 */

import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { ConfigError } from './numbers';
import type { BunqueueConfig } from './types';

const CONFIG_FILENAMES = ['bunqueue.config.ts', 'bunqueue.config.js', 'bunqueue.config.mjs'];

/** Load config file from explicit path or auto-discover in CWD */
export async function loadConfigFile(explicitPath?: string): Promise<BunqueueConfig | null> {
  if (explicitPath) {
    const abs = resolve(explicitPath);
    if (!existsSync(abs)) {
      throw new ConfigError([`Config file not found: ${abs}`]);
    }
    return importConfig(abs);
  }

  const cwd = process.cwd();
  for (const name of CONFIG_FILENAMES) {
    const candidate = join(cwd, name);
    if (existsSync(candidate)) {
      return importConfig(candidate);
    }
  }

  return null;
}

async function importConfig(filePath: string): Promise<BunqueueConfig> {
  const mod = (await import(filePath)) as { default?: BunqueueConfig };
  return mod.default ?? (mod as unknown as BunqueueConfig);
}

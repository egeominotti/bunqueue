/**
 * Run unchanged native documentation contracts against the published package.
 * Use only in an isolated `bun test --preload ...` process: the only substitutions
 * are module entry points, and both the TCP broker and embedded engine stay real.
 */
import { mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const portable = await import(resolve(root, 'sdk/typescript/dist/index.js'));
const embedded = await import(resolve(root, 'sdk/typescript/dist/embedded.js'));
if (typeof portable.Queue !== 'function' || typeof embedded.getSharedManager !== 'function') {
  throw new Error('Build the portable client before running its shared contracts');
}

await mock.module(resolve(root, 'src/client/index.ts'), () => portable);

// Mock every runtime export of the canonical manager module, so a new export cannot
// leave the shared contracts importing a name the mock lacks.
const managerPath = resolve(root, 'src/client/manager.ts');
const managerExports = [
  ...readFileSync(managerPath, 'utf8').matchAll(
    /^export\s+(?:async\s+function\*?|function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm
  ),
].map((match) => match[1]);
const missing = managerExports.filter((name) => !(name in embedded));
if (managerExports.length === 0 || missing.length > 0) {
  throw new Error(
    `sdk/typescript/dist/embedded.js does not export ${missing.join(', ') || 'the manager API'} ` +
      'from src/client/manager.ts: re-export it in scripts/client-portable/embedded-entry.ts ' +
      'and rebuild the portable client'
  );
}
await mock.module(managerPath, () =>
  Object.fromEntries(managerExports.map((name) => [name, embedded[name]]))
);

const redirected = await import(resolve(root, 'src/client'));
if (redirected.Queue !== portable.Queue || redirected.Worker !== portable.Worker) {
  throw new Error('Shared contracts did not resolve to the published portable client');
}

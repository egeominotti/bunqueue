/**
 * The opt-in tool settings are resolved once and shared: the HTTP transport builds one
 * McpServer per session, and must neither re-validate the environment nor repeat its
 * startup notices for every session.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { EmbeddedBackend } from '../src/mcp/adapter';
import { DecisionModel } from '../src/mcp/decisionModel';
import { HttpHandlerRegistry } from '../src/mcp/httpHandler';
import { createMcpServer } from '../src/mcp/serverFactory';
import { resolveToolSettings } from '../src/mcp/toolSetup';
import { shutdownManager } from '../src/client/manager';

const decision = new DecisionModel({
  provider: 'systemone',
  model: 'test',
  url: 'http://127.0.0.1:9/never-called',
  timeoutMs: 100,
});

const originalWrite = process.stderr.write.bind(process.stderr);
afterEach(() => {
  process.stderr.write = originalWrite;
  shutdownManager();
});

function captureStderr(): string[] {
  const lines: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return lines;
}

describe('resolveToolSettings', () => {
  test('prints each startup notice once, however many servers are built', async () => {
    shutdownManager();
    const backend = new EmbeddedBackend();
    const handlers = new HttpHandlerRegistry();
    const lines = captureStderr();
    // A decision model with neither confirmation nor dynamic toolsets is reported as unused.
    const settings = resolveToolSettings(backend, { env: {}, decision });
    for (let i = 0; i < 3; i++) {
      const server = createMcpServer(backend, handlers, { settings });
      await server.close();
    }
    process.stderr.write = originalWrite;
    expect(lines.filter((l) => l.includes('configured but unused'))).toHaveLength(1);
    handlers.shutdown();
    backend.shutdown();
  });

  test('rejects an invalid setting before any server is built', () => {
    shutdownManager();
    const backend = new EmbeddedBackend();
    expect(() => resolveToolSettings(backend, { env: { BUNQUEUE_MCP_TOOLSETS: 'nope' } })).toThrow(
      /Unknown BUNQUEUE_MCP_TOOLSETS/
    );
    backend.shutdown();
  });
});
